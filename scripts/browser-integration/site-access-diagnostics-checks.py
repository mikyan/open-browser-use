"""One public typed diagnostics/body workflow; parent verifies original evidence."""
import base64
import json
from pathlib import Path
import sys
import time
from open_browser_use import connect_open_browser_use


def run(endpoint, config, detail):
    scope = config["scope"]
    detail.update(scope=scope, tabId=config["tabId"])
    browser = connect_open_browser_use(endpoint, session_id=scope["session_id"], turn_id=scope["turn_id"], timeout=15)
    failure = None
    try:
        control = browser.client.request("getControlState")
        assert control["controlEpoch"] == scope["control_epoch"] and not control.get("closing")
        tab = browser.tab(config["tabId"])
        detail["initial"] = tab.diagnostics(limit=200, timeout_ms=5000)
        if config["layout"] == "dynamic-oopif":
            tab.locator("#add-diagnostics-frame").click()
        target = tab if config["layout"] == "root" else tab.frame_locator("#diagnostics-frame")
        target.locator("#note").fill(config["value"])
        target.locator("#save").click()
        target.get_by_text("Saved " + config["key"], exact=True).wait_for(timeout_ms=5000)
        detail["receipt"] = target.locator("#receipt").text_content()
        deadline = time.monotonic() + 5
        detail["snapshots"] = []
        while True:
            remaining = max(1, int((deadline - time.monotonic()) * 1000))
            capture = tab.diagnostics(after=detail["initial"]["cursor"], limit=200, timeout_ms=remaining)
            detail["snapshots"].append(capture)
            logs = [entry for entry in capture["entries"] if entry["kind"] == "console" and entry.get("text") == "Original diagnostics console " + config["key"]]
            errors = [entry for entry in capture["entries"] if entry["kind"] == "pageerror" and entry.get("message") == "Original diagnostics error " + config["key"]]
            responses = [entry for entry in capture["entries"] if entry["kind"] == "response" and entry.get("url") == config["apiURL"] and entry.get("method") == "POST" and entry.get("status") == 201]
            finished = responses and any(entry["kind"] == "requestfinished" and entry.get("requestId") == responses[0]["requestId"] for entry in capture["entries"])
            if logs and errors and responses and finished:
                assert len(responses) == 1
                detail["capture"] = capture
                break
            if time.monotonic() >= deadline or len(detail["snapshots"]) >= 64:
                raise RuntimeError("Original diagnostics events did not arrive within their read deadline")
            time.sleep(0.025)
        detail["reference"] = {"captureId": capture["captureId"], "requestId": responses[0]["requestId"]}
        detail["body"] = tab.response_body(capture_id=capture["captureId"], request_id=responses[0]["requestId"], max_bytes=65536, timeout_ms=10000)
        detail["decoded"] = json.loads(base64.b64decode(detail["body"]["data"], validate=True))
    except Exception as error:
        failure = error
    finally:
        try:
            browser.close()
        except Exception as error:
            detail.setdefault("cleanupErrors", []).append(str(error))
            if failure is None:
                failure = error
    if failure is not None:
        detail["error"] = str(failure)
        raise failure
    return detail


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    assert len(sys.argv) == 4
    endpoint, config_path, output_path = sys.argv[1:4]
    detail = {}
    failed = False
    try:
        run(endpoint, json.loads(Path(config_path).read_text(encoding="utf-8")), detail)
    except Exception as error:
        detail["error"] = str(error)
        failed = True
    encoded = json.dumps(detail, ensure_ascii=False)
    with Path(output_path).open("x", encoding="utf-8") as output:
        output.write(encoded + "\n")
    print(encoded)
    if failed:
        sys.exit(1)
