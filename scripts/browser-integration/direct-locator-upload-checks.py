"""Public Python locator upload. Parent hooks only observe native evidence."""
import json
import sys
import time
import traceback
import uuid
from pathlib import Path
from urllib.parse import urlencode
from open_browser_use import connect_open_browser_use


def run(endpoint, base_url, files, hook):
    key = "direct-python-" + uuid.uuid4().hex
    detail = {"caller": "python", "key": key, "variants": [], "createdTabIds": [], "trace": [], "passed": False}
    browser = None
    finalize_attempted = False

    def step(method, args, call):
        entry = {"index": len(detail["trace"]), "method": method, "args": args, "requestedAt": time.time_ns() // 1000000}
        detail["trace"].append(entry)
        try:
            value = call()
            entry["completedAt"] = time.time_ns() // 1000000
            return value
        except Exception as error:
            entry["error"] = str(error)
            raise

    try:
        browser = connect_open_browser_use(endpoint, session_id=key, timeout=15)
        control = step("beginTurn", {}, browser.client.begin_turn)
        detail["scope"] = {"session_id": key, "turn_id": control["nextTurnId"], "control_epoch": control["controlEpoch"]}
        for variant in ["root", "same", "dynamic-oopif"]:
            item = {"key": key + "-" + variant, "variant": variant, "passed": False}
            detail["variants"].append(item)
            started = False
            business_error = None
            try:
                tab = step("newTab", {}, browser.new_tab)
                item["tabId"] = tab.id
                detail["createdTabIds"].append(tab.id)
                started = True
                hook("start", item)
                item["url"] = base_url.rstrip("/") + "/direct-locator-upload/page?" + urlencode({"key": item["key"], "variant": variant})
                step("goto", {"tabId": tab.id, "url": item["url"]}, lambda: tab.goto(item["url"]))
                item["engine"] = step("engineInfo", {"tabId": tab.id}, lambda: browser.client.browser_action(tab.id, "engineInfo", timeout_ms=10000))
                assert item["engine"]["engine"]["capabilities"]["locatorFileUpload"] == 1
                context = tab if variant == "root" else tab.frame_locator("#upload-frame")

                def read(selector):
                    return json.loads(step("innerText", {"tabId": tab.id, "selector": selector}, lambda: context.locator(selector).inner_text(timeout_ms=10000)))

                def set_files(selector, paths):
                    return step("setInputFiles", {"tabId": tab.id, "selector": selector, "files": paths, "timeoutMs": 10000}, lambda: context.locator(selector).set_input_files(paths, timeout_ms=10000))

                item["before"] = read("#state")
                if variant == "root":
                    item["negatives"] = []
                    for name, selector, payload in [("strict", ".ambiguous", [f["path"] for f in files]), ("non-file", "#non-file", [f["path"] for f in files]), ("null", None, None), ("relative", None, ["relative.txt"])]:
                        record = {"name": name}
                        item["negatives"].append(record)
                        try:
                            if selector is not None:
                                set_files(selector, payload)
                            else:
                                step("invalidFiles", {"files": payload}, lambda: browser.client.browser_action(tab.id, "setInputFiles", locator=[{"kind": "css", "selector": "#upload"}], args={"files": payload}, timeout_ms=10000))
                        except Exception as error:
                            record["error"] = str(error)
                        assert record.get("error"), "Invalid direct upload unexpectedly succeeded"
                        assert not any(text in record["error"].lower() for text in ["timeout", "timed out", "deadline", "disconnect"])
                    item["afterNegatives"] = read("#state")
                    assert item["afterNegatives"] == item["before"]
                item["uploadStartedAt"] = time.time_ns() // 1000000
                set_files("#upload", [f["path"] for f in files])
                item["uploadCompletedAt"] = time.time_ns() // 1000000
                step("waitFor", {"tabId": tab.id, "selector": "#receipt", "state": "visible"}, lambda: context.locator("#receipt").wait_for(state="visible", timeout_ms=10000))
                item["receipt"] = read("#receipt")
                item["uploaded"] = read("#state")
                item["clearStartedAt"] = time.time_ns() // 1000000
                set_files("#upload", [])
                item["clearCompletedAt"] = time.time_ns() // 1000000
                item["cleared"] = read("#state")
                item["passed"] = True
            except Exception as error:
                business_error = error
                item["error"] = str(error)
                raise
            finally:
                if started:
                    try:
                        hook("finish", item)
                    except Exception as error:
                        item["observerError"] = str(error)
                        if business_error is None:
                            raise
        finalize_attempted = True
        detail["finalizeResult"] = step("finalizeTabs", {"keep": []}, lambda: browser.client.finalize_tabs([]))
        detail["passed"] = True
    except Exception:
        detail["error"] = traceback.format_exc()
    finally:
        if browser:
            if not finalize_attempted:
                try:
                    detail["cleanupResult"] = browser.client.finalize_tabs([])
                except Exception as error:
                    detail["cleanupError"] = str(error)
            browser.close()
    return detail


def main():
    endpoint, base_url, files_path, output = sys.argv[1:5]
    next_id = 0

    def hook(kind, item):
        nonlocal next_id
        next_id += 1
        print(json.dumps({"type": "hook", "version": 1, "id": next_id, "kind": kind, "item": {name: item[name] for name in ["key", "variant", "tabId"]}}), flush=True)
        line = sys.stdin.readline(65538)
        if not line.endswith("\n") or len(line) > 65537:
            raise RuntimeError("Invalid direct upload parent ACK")
        ack = json.loads(line)
        if ack.get("type") != "ack" or ack.get("version") != 1 or ack.get("id") != next_id or ack.get("ok") is not True:
            raise RuntimeError("Direct upload parent rejected hook: " + str(ack))

    detail = run(endpoint, base_url, json.loads(Path(files_path).read_text(encoding="utf8")), hook)
    with Path(output).open("x", encoding="utf8") as file:
        json.dump(detail, file, ensure_ascii=False, indent=2)
    print(json.dumps({"type": "result", "version": 1, "result": detail}, ensure_ascii=False), flush=True)
    return 0 if detail["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
