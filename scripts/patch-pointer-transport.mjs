// Applied after the diagnostic guard patch. Preserve both private guards across
// the transport's parameter copy, including its asynchronous admission hooks.
function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2)
    throw new Error("Pinned Playwright pointer transport shape changed; review the native pointer guard");
  return source.replace(before, after);
}

export function patchCrxPointerTransport(source) {
  source = replaceOnce(source,
    "result = await this._send(debuggee, message.method, { ...message.params }, diagnosticReleaseGuard(message.params));",
    "result = await this._send(debuggee, message.method, { ...message.params }, diagnosticReleaseGuard(message.params), pointerCommandGuard(message.params));");
  source = replaceOnce(source,
    "  async _send(debuggee, method, commandParams, diagnosticGuard) {",
    "  async _send(debuggee, method, commandParams, diagnosticGuard, pointerGuard) {");
  source = replaceOnce(source,
    "const operation = () => { diagnosticGuard?.(); return chrome.debugger.sendCommand(debuggee, method, commandParams); };",
    "const operation = () => { diagnosticGuard?.(); pointerGuard?.check(); return chrome.debugger.sendCommand(debuggee, method, commandParams); };");
  source = replaceOnce(source,
    "openBrowserUseInputHooks.send(debuggee, method, commandParams, operation)",
    "openBrowserUseInputHooks.send(debuggee, method, commandParams, operation, pointerGuard)");
  return 'import { tagPointerCommand, pointerCommandGuard } from "../../../browser-pointer-guard.js";\n' + source;
}
