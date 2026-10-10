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
        tab = browser.new_tab(base_url.rstrip("/") + "/media-downloads/page")
        tab.wait_for_load_state("load", timeout=5)
        download = tab.locator("img#selected").download_media(filename="python-media.png", timeout_ms=5000)
        filename = Path(download.path(timeout_ms=5000)).resolve(strict=True)
        assert filename.parent == download_root, "Download escaped this run's directory"
        data = filename.read_bytes()
        assert data[:8] == b"\x89PNG\r\n\x1a\n" and struct.unpack(">II", data[16:24]) == (2, 1), "Expected synthetic 2x1 PNG"
        result = {"passed": True, "path": str(filename), "bytes": len(data),
                  "sha256": hashlib.sha256(data).hexdigest(), "base64": base64.b64encode(data).decode("ascii")}
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
