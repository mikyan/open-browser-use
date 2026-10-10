"""Public Python SDK checks; only the parent's verified memory-clipboard run may invoke this."""
import os
if os.environ.get("OBU_TEST_MEMORY_CLIPBOARD") != "1":
    raise RuntimeError("Clipboard acceptance requires the verified headless memory-clipboard harness")

import base64
import hashlib
import json
import sys
from pathlib import Path
from open_browser_use import connect_open_browser_use

endpoint, fixture_url, artifact_path, png_path = sys.argv[1:5]
artifact = Path(artifact_path)
assert not artifact.exists(), "clipboard artifact already exists"
png = Path(png_path).read_bytes()
assert png[:8] == b"\x89PNG\r\n\x1a\n"
text = "Python clipboard 中文🙂"
items = [{"entries": [{"mime_type": "text/plain", "text": text},
                       {"mime_type": "text/html", "text": "<b>" + text + "</b>"},
                       {"mime_type": "image/png", "base64": base64.b64encode(png).decode("ascii")}]}]
checks = []
browser = connect_open_browser_use(endpoint, session_id="python-clipboard-integration", turn_id="clipboard-acceptance", timeout=15)
try:
    assert browser.client.get_info()["metadata"]["clipboardVersion"] == 1
    tab = browser.new_tab(fixture_url)
    tab.clipboard.write_text(text)
    assert tab.clipboard.read_text() == text
    checks.append("text-unicode")
    tab.clipboard.write(items)
    actual = tab.clipboard.read()
    assert len(actual) == 1
    entries = {entry["mime_type"]: entry for entry in actual[0]["entries"]}
    assert set(entries) == {"text/plain", "text/html", "image/png"}
    assert entries["text/plain"]["text"] == text
    assert text in entries["text/html"]["text"]
    returned_png = base64.b64decode(entries["image/png"]["base64"], validate=True)
    assert returned_png[:8] == png[:8]
    checks.append("three-representations")
    tab.clipboard.write([])
    assert tab.clipboard.read() == actual
    checks.append("empty-items-no-op")
    for invalid in ([{"entries": [{"mime_type": "image/jpeg", "base64": base64.b64encode(png).decode()}]}],
                    [{"entries": [{"mime_type": "text/plain", "text": "x", "extra": True}]}]):
        try:
            tab.clipboard.write(invalid)
        except ValueError:
            pass
        else:
            raise AssertionError("invalid clipboard representation accepted")
    try:
        tab.clipboard.write_text("中文", max_bytes=1)
    except ValueError:
        pass
    else:
        raise AssertionError("clipboard byte cap ignored")
    assert tab.clipboard.read() == actual
    checks.append("invalid-and-oversize-no-mutation")
    with artifact.open("x", encoding="utf-8") as output:
        json.dump({"items": actual}, output, ensure_ascii=False)
    detail = {"checks": checks, "artifact": artifact.name, "tabId": tab.id,
              "pngBytes": len(returned_png), "pngSHA256": hashlib.sha256(returned_png).hexdigest()}
finally:
    try:
        browser.client.finalize_tabs([])
    finally:
        browser.close()
print(json.dumps(detail, ensure_ascii=False))
