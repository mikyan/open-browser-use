"""Independent synchronous connections: ready ACK, actual page click, collect."""
import json
from pathlib import Path
import sys
import time
from urllib.parse import urlencode, urlsplit
from open_browser_use import connect_open_browser_use


def run(endpoint, base_url, prefix):
    assert urlsplit(base_url).hostname in {"127.0.0.1", "localhost"}
    options = {"session_id": prefix, "turn_id": "download-ready", "timeout": 15}
    owner = connect_open_browser_use(endpoint, **options)
    trigger = connect_open_browser_use(endpoint, **options)
    detail = {"caller": "python", "independentConnections": True, "variants": []}
    now = lambda: int(time.time() * 1000)
    try:
        assert owner.client.get_info()["metadata"]["downloadWaitVersion"] == 1
        for variant in ["root", "oopif", "dynamic-oopif"]:
            key = prefix + "-" + variant
            tab = owner.new_tab()
            owner.cdp.navigate(tab.id, base_url + "download-waits/page?" + urlencode({"key": key, "variant": variant}))
            sender = trigger.tab(tab.id)
            target = sender if variant == "root" else sender.frame_locator("#download-frame")
            wait = tab.expect_download(timeout_ms=10000)
            item = {"key": key, "variant": variant, "tabId": tab.id, "waiterId": wait.waiter_id, "remainingMs": wait.remaining_ms, "readyAt": now()}
            detail["variants"].append(item)
            try:
                if variant == "dynamic-oopif":
                    sender.get_by_role("button", name="Add download frame", exact=True).click()
                item["triggerSubmittedAt"] = now()
                target.get_by_role("link", name="Download fixture", exact=True).click(timeout_ms=5000)
                download = wait.result()
                item["result"] = {"downloadId": download.download_id}
                item["collectedAt"] = now()
                item["page"] = json.loads(target.locator("#evidence").text_content())
                if variant == "dynamic-oopif":
                    item["frameAdds"] = tab.evaluate("downloadEvidence.frameAdds")
                first = owner.client.request("getControlState")
                second = trigger.client.request("getControlState")
                assert first["controlEpoch"] == second["controlEpoch"]
                item["scope"] = {"session_id": prefix, "turn_id": "download-ready", "control_epoch": first["controlEpoch"]}
            finally:
                wait.cancel()
        return detail
    except Exception as error:
        error.download_detail = detail
        raise
    finally:
        trigger.close()
        owner.close()


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    endpoint, base_url, prefix, output_path = sys.argv[1:]
    failure = None
    try:
        result = run(endpoint, base_url, prefix)
    except Exception as error:
        failure = error
        result = {**getattr(error, "download_detail", {}), "error": str(error)}
    encoded = json.dumps(result, ensure_ascii=False)
    with Path(output_path).open("x", encoding="utf-8") as output:
        output.write(encoded + "\n")
    print(encoded)
    if failure:
        print(str(failure), file=sys.stderr)
        sys.exit(1)
