"""Parent-controlled browser connection-identity probe; stdout is JSON only."""

import json
import sys

from open_browser_use import OpenBrowserUseBrowser, OpenBrowserUseClient


DISCONNECTED = "OBU_SDK_BROWSER_DISCONNECTED"


def main():
    endpoint, session_id, tab_value, mode = sys.argv[1:]
    tab_id = int(tab_value)
    if mode not in ("close", "eof"):
        raise ValueError("mode must be close or eof")
    common = {"kind": "python", "mode": mode, "tabId": tab_id}

    def emit(phase, **fields):
        print(json.dumps({**common, "phase": phase, **fields}, ensure_ascii=False), flush=True)

    def command(expected):
        if sys.stdin.readline().strip() != expected:
            raise RuntimeError(f"Expected parent command: {expected}")

    def capture(operation, *, disconnected=True):
        try:
            operation()
        except Exception as error:
            message = f"{type(error).__name__}: {error}"
            if disconnected and DISCONNECTED not in message:
                raise AssertionError(f"Expected disconnected client error, got {message}") from error
            return message
        raise AssertionError("Old client operation unexpectedly succeeded")

    old = OpenBrowserUseClient(endpoint, session_id=session_id, timeout=5)
    fresh = None
    try:
        old.begin_turn()
        tab = OpenBrowserUseBrowser(old).tab(tab_id)
        locator = tab.locator("#stale-action")
        ready = tab.locator("#connection-ready").inner_text()
        if ready != "SDK_CONNECTION_READY":
            raise AssertionError(f"Unexpected ready marker: {ready!r}")
        emit("armed", readyText=ready, epoch=old._control_epoch, turn=old.turn_id)
        command("cut")
        if mode == "close":
            old.close()
        first = capture(lambda: locator.click(timeout_ms=1000), disconnected=mode == "close")
        operations = {
            "locator": lambda: locator.click(timeout_ms=1000),
            "beginTurn": old.begin_turn,
            "connect": old.connect,
            "manualEpoch": lambda: old.request("browserAction", {
                "session_id": session_id, "turn_id": old.turn_id, "control_epoch": old._control_epoch,
                "tabId": tab_id, "action": "click", "locator": [{"kind": "css", "selector": "#stale-action"}],
                "timeoutMs": 1000}, timeout=3),
        }
        blocked = {name: capture(operation) for name, operation in operations.items()}
        emit("blocked", firstError=first, blockedErrors=blocked)
        command("recover")
        fresh = OpenBrowserUseClient(endpoint, session_id=session_id, timeout=5)
        fresh.begin_turn()
        OpenBrowserUseBrowser(fresh).tab(tab_id).locator("#recover-action").click(timeout_ms=1000)
        fresh_epoch, fresh_turn = fresh._control_epoch, fresh.turn_id
        fresh.close()
        old_error = capture(lambda: locator.click(timeout_ms=1000))
        emit("done", freshEpoch=fresh_epoch, freshTurn=fresh_turn, oldLocatorError=old_error)
    finally:
        old.close()
        if fresh is not None:
            fresh.close()


if __name__ == "__main__":
    main()
