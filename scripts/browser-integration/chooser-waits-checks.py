"""Two independent synchronous SDK connections; arm acknowledgement precedes click."""
import json
from pathlib import Path
import sys
import time
from urllib.parse import urlencode, urlsplit
from open_browser_use import connect_open_browser_use


def run(endpoint, base_url, prefix, paths):
    assert urlsplit(base_url).hostname in {"127.0.0.1", "localhost"}
    options = {"session_id": prefix, "turn_id": "chooser-ready", "timeout": 15}
    owner = connect_open_browser_use(endpoint, **options)
    trigger = connect_open_browser_use(endpoint, **options)
    result = {"caller": "python", "independentConnections": True, "variants": []}
    now = lambda: int(time.time() * 1000)
    try:
        assert owner.client.get_info()["metadata"]["fileChooserWaitVersion"] == 1
        for variant in ["root", "oopif", "dynamic-oopif"]:
            key = prefix + "-" + variant
            tab = owner.new_tab()
            owner.cdp.navigate(tab.id, base_url + "chooser-waits/page?" + urlencode({"key": key, "variant": variant}))
            sender = trigger.tab(tab.id)
            target = sender if variant == "root" else sender.frame_locator("#upload-frame")
            item = {"key": key, "variant": variant, "tabId": tab.id, "waits": [], "receipts": []}
            result["variants"].append(item)
            for sequence in [1, 2]:
                wait = tab.expect_file_chooser(timeout_ms=10000)
                event = {"waiterId": wait.waiter_id, "remainingMs": wait.remaining_ms, "readyAt": now()}
                item["waits"].append(event)
                assert wait.waiter_id and wait.remaining_ms > 0
                try:
                    if variant == "dynamic-oopif" and sequence == 1:
                        sender.get_by_role("button", name="Add upload frame", exact=True).click()
                    event["triggerSubmittedAt"] = now()
                    target.get_by_label("Upload fixture", exact=True).click(timeout_ms=5000)
                    event["result"] = wait.result()
                    event["collectedAt"] = now()
                    assert event["result"]["isMultiple"] == (variant != "root")
                    selected = (paths[:1] if variant == "root" else paths) if sequence == 1 else []
                    owner.client.set_file_chooser_files(event["result"]["fileChooserId"], selected)
                    deadline = time.monotonic() + 5
                    while True:
                        text = target.locator("#receipt").text_content()
                        receipt = json.loads(text) if text else None
                        if receipt and receipt["sequence"] == sequence:
                            break
                        if time.monotonic() >= deadline:
                            raise TimeoutError("chooser server receipt did not render")
                        time.sleep(.025)
                    item["receipts"].append(receipt)
                finally:
                    wait.cancel()
            first = owner.client.request("getControlState")
            second = trigger.client.request("getControlState")
            assert first["controlEpoch"] == second["controlEpoch"]
            item["scope"] = {"session_id": prefix, "turn_id": "chooser-ready", "control_epoch": first["controlEpoch"]}
            if variant == "dynamic-oopif":
                item["frameAdds"] = tab.evaluate("chooserEvidence.frameAdds")
        return result
    finally:
        # Node checks live OOPIF identities and its own HTTP ledger before
        # finalizing this exact session, even when this subprocess fails.
        trigger.close()
        owner.close()


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    endpoint, base_url, prefix, output_path, *paths = sys.argv[1:]
    result = run(endpoint, base_url, prefix, paths)
    encoded = json.dumps(result, ensure_ascii=False)
    with Path(output_path).open("x", encoding="utf-8") as output:
        output.write(encoded + "\n")
    print(encoded)
