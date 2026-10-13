"""Exercise the public typed dialog handle; original receipts are checked by the parent."""
import json
from pathlib import Path
import sys
from urllib.parse import urlencode, urlsplit
from open_browser_use import connect_open_browser_use


def run(endpoint, base, prefix, cases, key_prefix="python"):
    assert urlsplit(base).hostname in {"127.0.0.1", "localhost"}
    browser = connect_open_browser_use(endpoint, session_id=prefix, turn_id="dialog-decisions", timeout=15)
    detail = {"caller": "python", "variants": [], "passed": False}
    if key_prefix != "python":
        detail["keyPrefix"] = key_prefix
    try:
        for layout in ["root", "oopif", "dynamic-oopif"]:
            key = key_prefix + "-dialogs-" + layout
            tab = browser.new_tab()
            item = {"key": key, "layout": layout, "tabId": tab.id, "decisions": []}
            detail["variants"].append(item)
            tab.goto(base + "native-dialogs?" + urlencode({"key": key, "layout": layout}))
            target = tab if layout == "root" else tab.frame_locator("#dialog-frame")
            for index, case in enumerate(cases):
                decision = {**case["decision"], "message": case["decision"]["type"] + ": " + key}
                wait = tab.expect_dialog(decision, timeout_ms=10000)
                record = {"decision": decision, "dialogId": wait.dialog_id, "remainingMs": wait.remaining_ms}
                item["decisions"].append(record)
                failure = None
                try:
                    if layout == "dynamic-oopif" and index == 0:
                        tab.get_by_role("button", name="Add dialog frame", exact=True).click()
                    target.get_by_role("button", name=case["button"], exact=True).click()
                    record["result"] = wait.result()
                except Exception as error:
                    failure = error
                    record["error"] = str(error)
                    raise
                finally:
                    try:
                        wait.cancel()
                    except Exception as cleanup_error:
                        record["cleanupError"] = str(cleanup_error)
                        if failure is None:
                            raise
            target.get_by_role("button", name="Confirm transfer", exact=True).click()
        detail["passed"] = True
        return detail
    except Exception as error:
        error.dialog_detail = detail
        raise
    finally:
        browser.close()


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    endpoint, base, prefix, config, output = sys.argv[1:6]
    assert len(sys.argv) in {6, 7}
    key_prefix = sys.argv[6] if len(sys.argv) == 7 else "python"
    failure = None
    try:
        result = run(endpoint, base, prefix, json.loads(Path(config).read_text(encoding="utf-8")), key_prefix)
    except Exception as error:
        failure = error
        result = {**getattr(error, "dialog_detail", {}), "error": str(error)}
    encoded = json.dumps(result, ensure_ascii=False)
    with Path(output).open("x", encoding="utf-8") as file:
        file.write(encoded + "\n")
    print(encoded)
    if failure:
        print(str(failure), file=sys.stderr)
        sys.exit(1)
