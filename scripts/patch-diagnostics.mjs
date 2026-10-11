// Pinned Chromium Page event ingress only: no public ConsoleMessage schema or
// raw chrome.debugger event is changed, and standalone CRX remains unchanged.
function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) throw new Error("Pinned Playwright diagnostic fence shape changed; review native event/session cleanup");
  return source.replace(before, after);
}

export function patchCrxDiagnostics(source) {
  const page = '    this._page = new Page$1(this, browserContext);\n    this.utilityWorldName = `__playwright_utility_world_${this._page.guid}`;';
  source = replaceOnce(source, page, page.replace('\n    this.utilityWorldName', '\n    if (openBrowserUseInputHooks) beginDiagnosticFence(this._page);\n    this.utilityWorldName'));
  const frame = '    this._crPage = crPage;\n    this._page = crPage._page;\n    this._targetId = targetId;';
  source = replaceOnce(source, frame, frame.replace('\n    this._targetId', '\n    bindDiagnosticSession(this._page, client);\n    this._targetId'));
  const worker = '    const worker = new Worker$1(this._page, url2);\n    this._page.addWorker(event.sessionId, worker);';
  source = replaceOnce(source, worker, worker.replace('\n    this._page.addWorker', '\n    bindDiagnosticSession(this._page, session);\n    this._page.addWorker'));
  const console = '  async _onConsoleAPI(event) {\n    if (event.executionContextId === 0) {\n      return;\n    }\n    const context = this._contextIdToContext.get(event.executionContextId);';
  source = replaceOnce(source, console, console.replace('\n    if (event.executionContextId', '\n    if (!acceptDiagnosticEvent(this._page, this._client, "console", event)) return;\n    if (event.executionContextId'));
  const exception = 'eventsHelper.addEventListener(this._client, "Runtime.exceptionThrown", (exception) => this._handleException(exception.exceptionDetails))';
  source = replaceOnce(source, exception, 'eventsHelper.addEventListener(this._client, "Runtime.exceptionThrown", (exception) => { if (acceptDiagnosticEvent(this._page, this._client, "exception", exception)) this._handleException(exception.exceptionDetails); })');
  const log = '  _onLogEntryAdded(event) {\n    const { level, text, args, source: source2, url: url2, lineNumber } = event.entry;';
  source = replaceOnce(source, log, log.replace('\n    const {', '\n    if (!acceptDiagnosticEvent(this._page, this._client, "log", event)) return;\n    const {'));
  const workerConsole = '    session.on("Runtime.consoleAPICalled", (event2) => {\n      const args = event2.args.map((o) => createHandle$3(worker.existingExecutionContext, o));';
  source = replaceOnce(source, workerConsole, workerConsole.replace('\n      const args', '\n      if (!acceptDiagnosticEvent(this._page, session, "console", event2)) return;\n      const args'));
  const workerException = '    session.on("Runtime.exceptionThrown", (exception) => this._page.emitOnContextOnceInitialized(BrowserContext$1.Events.PageError, exceptionToError(exception.exceptionDetails), this._page));';
  source = replaceOnce(source, workerException, '    session.on("Runtime.exceptionThrown", (exception) => { if (acceptDiagnosticEvent(this._page, session, "exception", exception)) this._page.emitOnContextOnceInitialized(BrowserContext$1.Events.PageError, exceptionToError(exception.exceptionDetails), this._page); });');
  // These two transport anchors are after patchCrxTransport. A private WeakMap
  // tag stays out of wire params and survives the transport's ordinary copy.
  const send = 'result = await this._send(debuggee, message.method, { ...message.params });';
  source = replaceOnce(source, send, 'result = await this._send(debuggee, message.method, { ...message.params }, diagnosticReleaseGuard(message.params));');
  const method = '  async _send(debuggee, method, commandParams) {';
  source = replaceOnce(source, method, '  async _send(debuggee, method, commandParams, diagnosticGuard) {');
  const operation = 'const operation = () => chrome.debugger.sendCommand(debuggee, method, commandParams);';
  source = replaceOnce(source, operation, 'const operation = () => { diagnosticGuard?.(); return chrome.debugger.sendCommand(debuggee, method, commandParams); };');
  return 'import { beginDiagnosticFence, bindDiagnosticSession, acceptDiagnosticEvent, diagnosticReleaseGuard } from "../../../browser-diagnostic-fence.js";\n' + source;
}
