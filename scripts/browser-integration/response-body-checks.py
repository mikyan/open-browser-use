"""Read one original response using the public typed Python facade; no trigger/retry."""
import json
import sys
from open_browser_use import connect_open_browser_use


def run(config):
    scope = config["scope"]
    browser = connect_open_browser_use(config["endpoint"], session_id=scope["session_id"], turn_id=scope["turn_id"], timeout=15)
    try:
        state = browser.client.request("getControlState")
        assert state["controlEpoch"] == scope["control_epoch"] and not state.get("closing")
        value = browser.tab(config["tabId"]).response_body(capture_id=config["reference"]["captureId"], request_id=config["reference"]["requestId"],
                                                        max_bytes=config["maxBytes"], timeout_ms=config["timeoutMs"])
        return {"caller": "python", "scope": scope, "tabId": config["tabId"], "value": value}
    finally:
        browser.close()


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    try:
        print(json.dumps(run(json.load(sys.stdin)), ensure_ascii=False))
    except Exception as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=False))
        sys.exit(1)
