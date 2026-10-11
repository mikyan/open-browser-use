"""Opt-in local geometry fixture through public typed Python SDK methods."""
import json
import sys
import time
import traceback
import uuid
from pathlib import Path
from open_browser_use import connect_open_browser_use

endpoint, fixture_url, output, expected_dpr_arg = sys.argv[1:5]
if expected_dpr_arg not in ["1", "1.5", "2"]:
    raise ValueError("Expected startup DPR 1, 1.5 or 2")
expected_dpr = float(expected_dpr_arg)
key = "geometry-python-" + uuid.uuid4().hex[:12]
detail = {"kind": "python", "key": key, "expectedDPR": expected_dpr, "phases": [], "trace": []}
browser = None
finalize_attempted = False


def step(operation, args, call):
    record = {"index": len(detail["trace"]), "kind": "python", "operation": operation,
              "args": args, "requestedAt": time.time_ns() // 1000000}
    detail["trace"].append(record)
    try:
        value = call()
        record["completedAt"] = time.time_ns() // 1000000
        return value
    except Exception as error:
        record["error"] = str(error)
        raise


try:
    browser = connect_open_browser_use(endpoint, session_id=key, timeout=15)
    control = step("beginTurn", {}, browser.client.begin_turn)
    detail["scope"] = {"session_id": key, "turn_id": control["nextTurnId"], "control_epoch": control["controlEpoch"]}
    tab = step("newTab", {}, browser.new_tab)
    detail["tabId"] = tab.id
    url = fixture_url.rstrip("/") + "/snapshot-geometry?key=" + key
    step("goto", {"url": url}, lambda: tab.goto(url))
    for phase in [0, 1, 2]:
        item = {"phase": phase, "dpr": expected_dpr}
        detail["phases"].append(item)
        expression = f"__snapshotGeometry.configure({phase})"
        item["before"] = step("evaluate", {"expression": expression}, lambda: tab.evaluate(expression, await_promise=True))
        if phase == 0:
            item["defaultCapture"] = step("snapshotAI", {}, tab.snapshot_ai)
            item["falseCapture"] = step("snapshotAI", {"boxes": False}, lambda: tab.snapshot_ai(boxes=False))
        item["capture"] = step("snapshotAI", {"boxes": True}, lambda: tab.snapshot_ai(boxes=True))
        item["after"] = step("evaluate", {"expression": "__snapshotGeometry.read()"}, lambda: tab.evaluate("__snapshotGeometry.read()", await_promise=True))
        item["screenshot"] = step("screenshot", {}, tab.screenshot)
    finalize_attempted = True
    detail["finalizeResult"] = step("finalizeTabs", {"keep": []}, lambda: browser.client.finalize_tabs([]))
except Exception:
    detail["error"] = traceback.format_exc()
finally:
    if browser is not None:
        if not finalize_attempted:
            try:
                detail["cleanupResult"] = step("finalizeTabs", {"keep": []}, lambda: browser.client.finalize_tabs([]))
            except Exception as error:
                detail["cleanupError"] = str(error)
        browser.close()
    with Path(output).open("x", encoding="utf8") as file:
        json.dump(detail, file, ensure_ascii=False, indent=2)
    print(json.dumps({"output": output, "error": detail.get("error")}, ensure_ascii=False))
sys.exit(1 if detail.get("error") else 0)
