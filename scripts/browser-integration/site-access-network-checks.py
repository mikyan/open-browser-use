"""One scoped public typed network-wait workflow; parent verifies native/HTTP evidence."""
import json
from pathlib import Path
import sys
from open_browser_use import connect_open_browser_use


def run(endpoint, config, detail):
    scope = config["scope"]
    detail.update(scope=scope, tabId=config["tabId"], cancelled=False)
    browser = connect_open_browser_use(endpoint, session_id=scope["session_id"], turn_id=scope["turn_id"], timeout=15)
    waits = []
    failure = None
    try:
        control = browser.client.request("getControlState")
        assert control["controlEpoch"] == scope["control_epoch"] and not control.get("closing")
        tab = browser.tab(config["tabId"])
        for event in ["request", "response"]:
            match = {"url": config["apiURL"], "method": "POST"}
            if event == "response":
                match["status"] = 201
            handle = (tab.expect_request if event == "request" else tab.expect_response)(match, timeout_ms=10000)
            waits.append(handle)
            detail[event + "Ack"] = {"waiterId": handle.waiter_id, "remainingMs": handle.remaining_ms}
        if config["layout"] == "dynamic-oopif":
            tab.locator("#add-network-frame").click()
        target = tab if config["layout"] == "root" else tab.frame_locator("#network-frame")
        target.locator("#note").fill(config["value"])
        target.locator("#save").click()
        detail["request"] = waits[0].result()
        detail["response"] = waits[1].result()
        detail["responseAgain"] = waits[1].result()
        target.get_by_text("Saved " + config["key"] + " 1 ", exact=False).wait_for(timeout_ms=5000)
        detail["receipt"] = target.locator("#receipt").text_content()
    except Exception as error:
        failure = error
    finally:
        detail["cancelled"] = True
        for wait in waits:
            try:
                wait.cancel()
            except Exception as error:
                detail["cancelled"] = False
                detail.setdefault("cleanupErrors", []).append(str(error))
                if failure is None:
                    failure = error
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
    endpoint, config_path, output_path = sys.argv[1:4]
    assert len(sys.argv) == 4
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
