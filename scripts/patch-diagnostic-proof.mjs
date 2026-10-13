// Private provenance only. No ConsoleMessage/Error initializer, protocol field,
// page script or public diagnostic entry gains a proof token.
export const diagnosticProofBridge = `
const openBrowserUseServerDiagnostics = new WeakMap();
const openBrowserUseClientDiagnostics = new WeakMap();
let openBrowserUseSendingDiagnostic;
let openBrowserUseReceivingDiagnostic;
function diagnosticProofError() { return new Error("OBU_SITE_ACCESS_UNVERIFIED: original diagnostic document could not be verified"); }
function captureOpenBrowserUseDiagnosticContext(owner, contextId) {
  try {
    const context = owner._contextIdToContext.get(contextId), page = owner._page, session = owner._client;
    const frame = context?.frame, route = networkProofRoute(session);
    if (!Number.isSafeInteger(contextId) || contextId < 1 || !frame || frame._page !== page) throw diagnosticProofError();
    const documents = networkDocumentMap(route.identity), lineage = [], seen = new Set();
    for (let current = frame; current; current = current.parentFrame()) {
      if (seen.has(current) || lineage.length >= 1000 || current._page !== page || !current._currentDocument) throw diagnosticProofError();
      seen.add(current);
      if (!documents.has(current._id)) documents.set(current._id, {});
      lineage.push(Object.freeze({ frame: current, id: current._id, document: current._currentDocument,
        url: current.url(), token: documents.get(current._id) }));
    }
    const urls = lineage.map(item => item.url).filter(url => !["", "about:blank", "about:srcdoc"].includes(url));
    if (!urls.length || ["", "about:blank", "about:srcdoc"].includes(lineage.at(-1).url)) throw diagnosticProofError();
    const check = () => {
      route.check();
      if (page.isClosed?.() || session._closed || session._crashed || session._connection._sessions.get(session._sessionId) !== session ||
          owner._contextIdToContext.get(contextId) !== context || context.frame !== frame) throw diagnosticProofError();
      for (let index = 0; index < lineage.length; index++) {
        const item = lineage[index], current = item.frame;
        if (current.isDetached() || page.frameManager.frame(item.id) !== current || current._page !== page || current._currentDocument !== item.document ||
            current.parentFrame() !== (lineage[index + 1]?.frame ?? null) || documents.get(item.id) !== item.token) throw diagnosticProofError();
      }
    };
    check();
    return Object.freeze({ page, urls: Object.freeze(urls), check });
  } catch { return null; }
}
function bindOpenBrowserUseServerDiagnostic(value, proof) {
  openBrowserUseServerDiagnostics.set(value, proof ?? null);
  return value;
}
function dispatchOpenBrowserUseDiagnostic(dispatcher, method, params, original) {
  const previous = openBrowserUseSendingDiagnostic;
  openBrowserUseSendingDiagnostic = { method, guid: dispatcher._guid, pageGuid: params.page?._guid,
    proof: openBrowserUseServerDiagnostics.get(original) ?? null };
  try { dispatcher._dispatchEvent(method, params); }
  finally { openBrowserUseSendingDiagnostic = previous; }
}
function captureOpenBrowserUseDiagnosticMessage(message) {
  const original = openBrowserUseSendingDiagnostic;
  // The validator creates a new params object. Bind the exact outgoing message
  // while dispatch is synchronous, then retain it only in its existing callback.
  return original && ["console", "pageError"].includes(message.method) && message.method === original.method && message.guid === original.guid &&
    message.params?.page?.guid === original.pageGuid ? Object.freeze({ ...original, message }) : null;
}
function deliverOpenBrowserUseDiagnosticMessage(connection, message, original) {
  const previous = openBrowserUseReceivingDiagnostic;
  openBrowserUseReceivingDiagnostic = original?.message === message ? original : null;
  try { return connection.dispatch(message); }
  finally { openBrowserUseReceivingDiagnostic = previous; }
}
function bindOpenBrowserUseClientDiagnostic(value, page, method) {
  const original = openBrowserUseReceivingDiagnostic;
  const proof = original?.method === method && original.pageGuid === page?._guid ? original.proof : null;
  openBrowserUseClientDiagnostics.set(value, { kind: method === "pageError" ? "pageerror" : method, proof });
}
export function captureOpenBrowserUseDiagnosticSource(kind, value, clientPage) {
  const captured = openBrowserUseClientDiagnostics.get(value);
  let page;
  try { page = clientPage?._toImpl?.(); } catch { throw diagnosticProofError(); }
  if (!["console", "pageerror"].includes(kind) || captured?.kind !== kind || !captured.proof || captured.proof.page !== page) throw diagnosticProofError();
  captured.proof.check();
  return captured.proof;
}
`;

function once(source, before, after) {
  if (source.split(before).length !== 2) throw new Error("Pinned Playwright diagnostic proof shape changed; review original native context and event mapping");
  return source.replace(before, after);
}

export function patchCrxDiagnosticProof(source) {
  if (source.includes("captureOpenBrowserUseDiagnosticContext") || !source.includes("function networkProofRoute(session)") ||
      !source.includes("function networkDocumentMap(identity)") || !source.includes("observeOpenBrowserUseNetworkDocument(this, tabId, message, params)"))
    throw new Error("Pinned Playwright diagnostic proof requires original network document lifecycle");
  const fence = '    if (!acceptDiagnosticEvent(this._page, this._client, "console", event)) return;\n';
  const consoleStart = '  async _onConsoleAPI(event) {\n' + (source.includes(fence) ? fence : '') +
    '    if (event.executionContextId === 0) {\n      return;\n    }\n    const context = this._contextIdToContext.get(event.executionContextId);';
  source = once(source, consoleStart, consoleStart.replace(' {\n',
    ' {\n    const obuProof = captureOpenBrowserUseDiagnosticContext(this, event.executionContextId);\n'));
  source = once(source, "    this._page.addConsoleMessage(event.type, values, toConsoleMessageLocation(event.stackTrace));",
    "    this._page.addConsoleMessage(event.type, values, toConsoleMessageLocation(event.stackTrace), undefined, obuProof);");
  source = once(source, "  addConsoleMessage(type2, args, location2, text) {", "  addConsoleMessage(type2, args, location2, text, obuProof) {");
  source = once(source, "    const message = new ConsoleMessage$1(this, type2, text, args, location2);",
    "    const message = bindOpenBrowserUseServerDiagnostic(new ConsoleMessage$1(this, type2, text, args, location2), obuProof);");
  source = once(source, "  _handleException(exceptionDetails) {\n    this._page.emitOnContextOnceInitialized(BrowserContext$1.Events.PageError, exceptionToError(exceptionDetails), this._page);",
    "  _handleException(exceptionDetails) {\n    const obuProof = captureOpenBrowserUseDiagnosticContext(this, exceptionDetails.executionContextId);\n    const obuError = bindOpenBrowserUseServerDiagnostic(exceptionToError(exceptionDetails), obuProof);\n    this._page.emitOnContextOnceInitialized(BrowserContext$1.Events.PageError, obuError, this._page);");
  source = once(source, '      this._dispatchEvent("pageError", { error: serializeError$1(error2), page: PageDispatcher.from(this, page) });',
    '      dispatchOpenBrowserUseDiagnostic(this, "pageError", { error: serializeError$1(error2), page: PageDispatcher.from(this, page) }, error2);');
  const console = '        this._dispatchEvent("console", {\n          page: pageDispatcher,';
  source = once(source, console, '        dispatchOpenBrowserUseDiagnostic(this, "console", {\n          page: pageDispatcher,');
  source = once(source, '          location: message.location()\n        });', '          location: message.location()\n        }, message);');
  source = once(source, 'dispatcherConnection.onmessage = (message) => setImmediate(() => clientConnection.dispatch(message));',
    'dispatcherConnection.onmessage = (message) => {\n  const obuDelivery = captureOpenBrowserUseDiagnosticMessage(message);\n  setImmediate(() => deliverOpenBrowserUseDiagnosticMessage(clientConnection, message, obuDelivery));\n};');
  source = once(source, '    this._event = event;\n    if (platform.inspectCustom)',
    '    this._event = event;\n    bindOpenBrowserUseClientDiagnostic(this, this._page, "console");\n    if (platform.inspectCustom)');
  source = once(source, '      const parsedError = parseError(error2);\n      this.emit(Events.BrowserContext.WebError, new WebError(pageObject, parsedError));',
    '      const parsedError = parseError(error2);\n      bindOpenBrowserUseClientDiagnostic(parsedError, pageObject, "pageError");\n      this.emit(Events.BrowserContext.WebError, new WebError(pageObject, parsedError));');
  return source + "\n" + diagnosticProofBridge;
}
