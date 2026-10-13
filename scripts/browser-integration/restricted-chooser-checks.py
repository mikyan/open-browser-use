"""Public typed chooser workflow; private native/file oracle stays with the parent."""
import json
from pathlib import Path
import sys
import time
from open_browser_use import connect_open_browser_use


def now():
    return int(time.time() * 1000)


def run(endpoint, config, detail):
    scope = config["scope"]
    detail.update(scope=scope, tabId=config["tabId"], waits=[], receipts=[])
    browser = connect_open_browser_use(endpoint, session_id=scope["session_id"], turn_id=scope["turn_id"], timeout=15)
    failure = None
    try:
        control = browser.client.request("getControlState")
        assert control["controlEpoch"] == scope["control_epoch"] and not control.get("closing")
        tab = browser.tab(config["tabId"])
        target = tab if config["layout"] == "root" else tab.frame_locator("#upload-frame")
        for sequence in [1, 2]:
            item = {"sequence": sequence, "armStartedAt": now()}
            detail["waits"].append(item)
            wait = None
            try:
                wait = tab.expect_file_chooser(timeout_ms=10000)
                item.update(waiterId=wait.waiter_id, remainingMs=wait.remaining_ms, readyAt=now())
                if sequence == 1 and config["layout"] == "dynamic-oopif":
                    tab.get_by_role("button", name="Add upload frame", exact=True).click()
                item["triggerSubmittedAt"] = now()
                target.get_by_label("Upload fixture", exact=True).click(timeout_ms=5000)
                item["triggerCompletedAt"] = now()
                item["result"] = wait.result()
                item["collectedAt"] = now()
                assert item["result"]["isMultiple"] == (config["layout"] != "root")
                item["files"] = config["paths"][:] if sequence == 1 else []
                item["setStartedAt"] = now()
                item["setResult"] = browser.client.set_file_chooser_files(item["result"]["fileChooserId"], item["files"])
                item["setCompletedAt"] = now()
                deadline = time.monotonic() + 5
                for attempt in range(101):
                    raw = target.locator("#receipt").text_content()
                    receipt = json.loads(raw) if raw else None
                    if receipt and receipt.get("sequence") == sequence:
                        item["receipt"] = receipt
                        detail["receipts"].append(receipt)
                        break
                    if time.monotonic() >= deadline or attempt == 100:
                        raise TimeoutError("Original chooser receipt did not arrive")
                    time.sleep(.025)
            except Exception as error:
                failure = error
                item["error"] = str(error)
            finally:
                if wait is not None:
                    try:
                        item["cancelResult"] = wait.cancel()
                        item["cancelled"] = True
                    except Exception as error:
                        item["cancelError"] = str(error)
                        if failure is None:
                            failure = error
            if failure is not None:
                break
    except Exception as error:
        failure = error
    finally:
        try:
            browser.close()
        except Exception as error:
            detail["connectionCleanupError"] = str(error)
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
    detail, failed = {}, False
    try:
        run(endpoint, json.loads(Path(config_path).read_text(encoding="utf-8")), detail)
    except Exception as error:
        detail["error"], failed = str(error), True
    encoded = json.dumps(detail, ensure_ascii=False)
    with Path(output_path).open("x", encoding="utf-8") as output:
        output.write(encoded + "\n")
    print(encoded)
    if failed:
        sys.exit(1)
