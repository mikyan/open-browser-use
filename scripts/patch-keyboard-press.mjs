// Applied after the fill/pointer patches. Keep the pinned key parser and actual
// down/up sequence; only move complete validation ahead of input and bind each
// submitted chord to its original action/attachment. No guessed key releases.
export const keyboardPressBridge = `
const obuKeyboardPressProgress = Symbol("Open Browser Use keyboard press progress");

function obuKeyboardPressFailure(error, phase) {
  const failure = new NonRecoverableDOMError("OBU_KEYBOARD_PRESS_" + phase + ": " + (error?.message || String(error)));
  failure.cause = error;
  return failure;
}

function obuKeyboardPressAdmission(keyboard, options) {
  const inherited = options[obuFillTicket];
  const progress = options[obuKeyboardPressProgress];
  let ticket = inherited, ownsTicket = false, routeCheck = () => {};
  const check = () => {
    progress?.throwIfAborted();
    if (progress && progress.timeUntilDeadline() <= 0)
      throw new Error("original keyboard press deadline expired");
    routeCheck();
  };
  const checkpoint = () => { check(); ticket?.check(); };
  if (!inherited && openBrowserUseInputHooks?.beginKeyboardPress) {
    const client = keyboard._raw?._client, transport = client?._connection?._transport;
    const root = /^crx-tab-(\\d+)$/.exec(client?._sessionId || "");
    const tabId = root ? Number(root[1]) : transport?._sessions?.get(client?._sessionId);
    const attachment = transport?._tabToTarget?.get(tabId);
    routeCheck = () => {
      if (!Number.isSafeInteger(tabId) || !attachment || transport._tabToTarget.get(tabId) !== attachment ||
          !root && transport._sessions.get(client._sessionId) !== tabId)
        throw new Error("original keyboard press attachment changed");
    };
    check();
    ticket = openBrowserUseInputHooks.beginKeyboardPress({ tabId }, check);
    if (!ticket || typeof ticket.check !== "function" || typeof ticket.close !== "function")
      throw new Error("keyboard press admission is unavailable");
    ownsTicket = true;
  }
  return { ticket, checkpoint, close() { if (ownsTicket) ticket.close(); } };
}
`;

function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) throw new Error("Pinned Playwright keyboard press shape changed");
  return source.replace(before, after);
}

export function patchCrxKeyboardPress(source) {
  const start = "  async press(key2, options2 = {}) {";
  const end = "  async ensureModifiers(mm, obuTicket) {";
  const keyboardStart = source.indexOf("let Keyboard$1 = class Keyboard {"), keyboardEnd = source.indexOf("let Mouse$1 = class Mouse {", keyboardStart);
  const from = source.indexOf(start, keyboardStart), to = source.indexOf(end, from);
  if (keyboardStart < 0 || keyboardEnd < keyboardStart || from < keyboardStart || to < from || to >= keyboardEnd ||
      source.slice(keyboardStart, keyboardEnd).split(start).length !== 2 || source.includes("_validateOpenBrowserUsePress("))
    throw new Error("Pinned Playwright keyboard press method shape changed");
  const method = source.slice(from, to);
  const parserEnd = "    const tokens = split(key2);\n";
  const parserFrom = method.indexOf("    function split(keyString) {"), parserTo = method.indexOf(parserEnd);
  if (parserFrom < 0 || parserTo < parserFrom || method.split(parserEnd).length !== 2)
    throw new Error("Pinned Playwright keyboard chord parser shape changed");
  // Reuse the actual pinned parser, including its special handling of '+'.
  // Descriptions are validated without mutating pressed sets. Native down/up
  // still resolve descriptions at their original moment (Shift/text/repeat).
  const parser = method.slice(parserFrom, parserTo + parserEnd.length);
  const validate = "  _validateOpenBrowserUsePress(key2) {\n    try {\n" + parser +
    "      for (const token of tokens) this._keyDescriptionForString(token);\n      return tokens;\n" +
    "    } catch (error) { throw obuKeyboardPressFailure(error, \"INVALID\"); }\n  }\n";
  let body = method.slice(parserTo + parserEnd.length);
  // Remove only this method's final brace, keeping the inherited execution.
  if (!body.endsWith("  }\n")) throw new Error("Pinned Playwright keyboard press body shape changed");
  body = body.slice(0, -4);
  for (const [before, after] of [
    ["this.down(tokens[i], options2[obuFillTicket])", "obuDown(tokens[i])"],
    ["this.down(key2, options2[obuFillTicket])", "obuDown(key2)"],
    ["this.up(key2, options2[obuFillTicket])", "obuUp(key2)"],
    ["this.up(tokens[i], options2[obuFillTicket])", "obuUp(tokens[i])"]
  ]) body = replaceOnce(body, before, after);
  const guarded = validate + start + `
    const tokens = this._validateOpenBrowserUsePress(key2);
    let obuAdmission, obuStarted = false;
    try {
      obuAdmission = obuKeyboardPressAdmission(this, options2);
      const obuDown = async key => {
        obuAdmission.checkpoint();
        // down mutates Playwright state before its raw native call. Even a
        // pre-dispatch failure from this point requires retiring that state.
        obuStarted = true;
        await this.down(key, obuAdmission.ticket);
        obuAdmission.checkpoint();
      };
      const obuUp = async key => {
        obuAdmission.checkpoint();
        await this.up(key, obuAdmission.ticket);
        obuAdmission.checkpoint();
      };
` + body + `
    } catch (error) {
      throw obuKeyboardPressFailure(error, obuStarted ? "UNCONFIRMED" : "REJECTED");
    } finally {
      // Closing admission does not release or replay native keys. The backend
      // owns actual pending input and explicit original-attachment cleanup.
      obuAdmission?.close();
    }
  }
`;
  source = source.slice(0, from) + guarded + source.slice(to);
  source = replaceOnce(source,
    '  async _press(progress2, key2, options2) {\n    progress2.log(`elementHandle.press("${key2}")`);',
    '  async _press(progress2, key2, options2) {\n    this._page.keyboard._validateOpenBrowserUsePress(key2);\n    progress2.log(`elementHandle.press("${key2}")`);');
  source = replaceOnce(source, "      await this._page.keyboard.press(key2, options2);",
    "      await this._page.keyboard.press(key2, { ...options2, [obuKeyboardPressProgress]: progress2 });");
  return source + keyboardPressBridge;
}
