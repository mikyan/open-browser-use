"""Two independent synchronous SDK connections; arm acknowledgement precedes click."""
import json
from pathlib import Path
import sys
import time
import traceback
from urllib.parse import urlencode, urlsplit
from open_browser_use import connect_open_browser_use


def now():
    return int(time.time() * 1000)


def new_result():
    return {"caller": "python", "independentConnections": True, "variants": [], "startedAt": now()}


def step(record, name, operation):
    stage = {"startedAt": now()}
    record.setdefault("stages", {})[name] = stage
    try:
        value = operation()
        stage["completedAt"] = now()
        return value
    except Exception as error:
        stage.update(failedAt=now(), error=str(error), errorType=type(error).__name__)
        record.setdefault("failedStage", name)
        raise


def failed(record, error, *, original=True):
    record.update(passed=False, failedAt=now(), error=str(error), errorType=type(error).__name__)
    if original:
        record["originalError"] = str(error)


def run(endpoint, base_url, prefix, paths, result=None):
    # The parent owns finalization. Even connect/newTab/arm failures must leave
    # partial identity without inventing a tab, waiter, scope or successful ACK.
    if result is None:
        result = new_result()
    owner = trigger = None
    failure = failure_traceback = None
    try:
        assert urlsplit(base_url).hostname in {"127.0.0.1", "localhost"}
        options = {"session_id": prefix, "turn_id": "chooser-ready", "timeout": 15}
        owner = step(result, "connectOwner", lambda: connect_open_browser_use(endpoint, **options))
        trigger = step(result, "connectTrigger", lambda: connect_open_browser_use(endpoint, **options))
        assert step(result, "getInfo", owner.client.get_info)["metadata"]["fileChooserWaitVersion"] == 1
        for variant in ["root", "oopif", "dynamic-oopif"]:
            key = prefix + "-" + variant
            item = {"key": key, "variant": variant, "startedAt": now(), "waits": [], "receipts": []}
            result["variants"].append(item)
            event = None
            try:
                tab = step(item, "newTab", owner.new_tab)
                item["tabId"] = tab.id
                step(item, "navigate", lambda: owner.cdp.navigate(tab.id, base_url + "chooser-waits/page?" + urlencode({"key": key, "variant": variant})))
                sender = trigger.tab(tab.id)
                target = sender if variant == "root" else sender.frame_locator("#upload-frame")
                for sequence in [1, 2]:
                    event = {"sequence": sequence, "startedAt": now()}
                    item["waits"].append(event)
                    wait = step(event, "arm", lambda: tab.expect_file_chooser(timeout_ms=10000))
                    event.update(waiterId=wait.waiter_id, remainingMs=wait.remaining_ms, readyAt=now())
                    assert wait.waiter_id and wait.remaining_ms > 0
                    operation_error = None
                    try:
                        if variant == "dynamic-oopif" and sequence == 1:
                            step(event, "addFrame", lambda: sender.get_by_role("button", name="Add upload frame", exact=True).click())
                        event["triggerSubmittedAt"] = now()
                        step(event, "click", lambda: target.get_by_label("Upload fixture", exact=True).click(timeout_ms=5000))
                        event["triggerCompletedAt"] = now()
                        event["result"] = step(event, "collect", wait.result)
                        event["collectedAt"] = now()
                        assert event["result"]["isMultiple"] == (variant != "root")
                        selected = (paths[:1] if variant == "root" else paths) if sequence == 1 else []
                        step(event, "setFiles", lambda: owner.client.set_file_chooser_files(event["result"]["fileChooserId"], selected))

                        def receipt_poll():
                            deadline = time.monotonic() + 5
                            while True:
                                text = target.locator("#receipt").text_content()
                                receipt = json.loads(text) if text else None
                                if receipt and receipt["sequence"] == sequence:
                                    return receipt
                                if time.monotonic() >= deadline:
                                    raise TimeoutError("chooser server receipt did not render")
                                time.sleep(.025)

                        item["receipts"].append(step(event, "receipt", receipt_poll))
                    except Exception as error:
                        operation_error = error
                        failed(event, error)
                        raise
                    finally:
                        try:
                            step(event, "cancel", wait.cancel)
                        except Exception as error:
                            event["cancelError"] = str(error)
                            item.setdefault("cleanupErrors", []).append({"stage": "cancel", "sequence": sequence, "error": str(error), "errorType": type(error).__name__})
                            if operation_error is None:
                                failed(event, error, original=False)
                                raise
                    event.update(passed=True, completedAt=now())
                event = None
                first = step(item, "ownerControlState", lambda: owner.client.request("getControlState"))
                second = step(item, "triggerControlState", lambda: trigger.client.request("getControlState"))
                assert first["controlEpoch"] == second["controlEpoch"]
                item["scope"] = {"session_id": prefix, "turn_id": "chooser-ready", "control_epoch": first["controlEpoch"]}
                if variant == "dynamic-oopif":
                    item["frameAdds"] = step(item, "frameAdds", lambda: tab.evaluate("chooserEvidence.frameAdds"))
                item.update(passed=True, completedAt=now())
            except Exception as error:
                failed(item, error)
                if event is not None:
                    if "error" not in event:
                        failed(event, error)
                    if "failedStage" in event:
                        item.setdefault("failedStage", event["failedStage"])
                result.setdefault("failedStage", item.get("failedStage", "variantValidation"))
                raise
    except Exception as error:
        failure, failure_traceback = error, error.__traceback__
        failed(result, error)
        result["errorTraceback"] = "".join(traceback.format_exception(type(error), error, error.__traceback__))
    finally:
        # Node checks live OOPIF identities and its own HTTP ledger before
        # finalizing this exact session, even when this subprocess fails.
        for name, connection in [("trigger", trigger), ("owner", owner)]:
            if connection is None:
                continue
            try:
                step(result, name + "Close", connection.close)
            except Exception as error:
                result[name + "CloseError"] = str(error)
                result.setdefault("cleanupErrors", []).append({"stage": name + "Close", "error": str(error), "errorType": type(error).__name__})
                if failure is None:
                    failure, failure_traceback = error, error.__traceback__
                    failed(result, error, original=False)
    if failure is not None:
        raise failure.with_traceback(failure_traceback)
    result.update(passed=True, completedAt=now())
    return result


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    endpoint, base_url, prefix, output_path, *paths = sys.argv[1:]
    result = new_result()
    failure = None
    try:
        run(endpoint, base_url, prefix, paths, result)
    except Exception as error:
        failure = error
    encoded = json.dumps(result, ensure_ascii=False)
    try:
        with Path(output_path).open("x", encoding="utf-8") as output:
            output.write(encoded + "\n")
    except Exception as error:
        result["outputError"] = str(error)
        result["passed"] = False
        encoded = json.dumps(result, ensure_ascii=False)
        if failure is None:
            failure = error
    print(encoded)
    if failure is not None:
        traceback.print_exception(type(failure), failure, failure.__traceback__, file=sys.stderr)
        raise SystemExit(1)
