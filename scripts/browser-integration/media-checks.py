"""Public Python media-download caller for the isolated integration fixture."""
import base64
import hashlib
import json
import os
from pathlib import Path
import struct
import sys
from urllib.parse import urlsplit
from uuid import uuid4

from open_browser_use import connect_open_browser_use


def main():
    if len(sys.argv) != 4:
        raise ValueError("usage: media-checks.py endpoint baseURL outputPath")
    endpoint, base_url, output = sys.argv[1:]
    parsed = urlsplit(base_url)
    assert parsed.scheme == "http" and parsed.hostname in {"127.0.0.1", "localhost"}, "Synthetic loopback fixture required"
    download_root = Path(os.environ["OBU_TEST_DOWNLOAD_ROOT"]).resolve(strict=True)
    browser = connect_open_browser_use(endpoint, session_id=f"python-media-{uuid4()}", turn_id="acceptance", timeout=15)
    download = None
    try:
        breadth = os.environ.get("OBU_TEST_MEDIA_VARIANT") == "breadth"
        tab = browser.new_tab(base_url.rstrip("/") + ("/media-breadth/page" if breadth else "/media-downloads/page"))
        tab.wait_for_load_state("load", timeout=5)
        readiness = tab.evaluate("mediaReady", await_promise=True) if breadth else None
        if breadth:
            state = next(state for state in readiness["states"] if state["id"] == "blob-wav")
            assert state["readyState"] >= 2 and state["duration"] > 0 and state["paused"] is True
            assert "loadedmetadata" in state["events"] and "loadeddata" in state["events"]
        download = tab.locator("#blob-wav" if breadth else "img#selected").download_media(
            filename="python-media-breadth.wav" if breadth else "python-media.png", timeout_ms=5000)
        filename = Path(download.path(timeout_ms=5000)).resolve(strict=True)
        assert filename.parent == download_root, "Download escaped this run's directory"
        data = filename.read_bytes()
        if breadth:
            assert len(data) == 1644 and data[:4] == b"RIFF" and data[8:16] == b"WAVEfmt "
            assert struct.unpack("<HHIIHH", data[20:36]) == (1, 1, 8000, 16000, 2, 16)
            assert data[36:40] == b"data" and struct.unpack("<I", data[40:44])[0] == 1600
            assert struct.unpack("<800h", data[44:]) == tuple(2048 if i % 20 < 10 else -2048 for i in range(800))
        else:
            assert data[:8] == b"\x89PNG\r\n\x1a\n" and struct.unpack(">II", data[16:24]) == (2, 1), "Expected synthetic 2x1 PNG"
        result = {"passed": True, "path": str(filename), "bytes": len(data),
                  "sha256": hashlib.sha256(data).hexdigest(), "base64": base64.b64encode(data).decode("ascii")}
        if breadth:
            page = tab.evaluate("({events:mediaEvents,traps:getterTraps})")
            assert page == {"events": [], "traps": []}
            result.update(kind="wav", readiness=readiness, page=page)
    finally:
        try:
            if download is not None:
                download.cancel(timeout_ms=5000)
        finally:
            try:
                browser.client.finalize_tabs([])
            finally:
                browser.close()
    encoded = json.dumps(result, ensure_ascii=False)
    with Path(output).open("x", encoding="utf-8") as handle:
        handle.write(encoded + "\n")
    print(encoded)


if __name__ == "__main__":
    main()
