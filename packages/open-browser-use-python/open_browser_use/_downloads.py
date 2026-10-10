from __future__ import annotations

import re
from typing import Any, Callable
from urllib.parse import urlsplit


def download_timeout(value: int | None) -> int:
    value = 10000 if value is None else value
    if type(value) is not int or not 1 <= value <= 120000:
        raise ValueError("Download timeout_ms must be an integer from 1 to 120000")
    return value


def download_params(url: str, filename: str | None, timeout_ms: int | None) -> dict[str, Any]:
    try:
        parsed = urlsplit(url)
        valid = (isinstance(url, str) and bool(url) and len(url.encode("utf-8")) <= 8192
                 and not re.search(r"[\x00-\x1f\x7f]", url) and url == url.strip() and parsed.scheme in ("http", "https")
                 and bool(parsed.hostname) and parsed.username is None and parsed.password is None)
        parsed.port
    except (ValueError, TypeError, UnicodeError):
        valid = False
    if not valid:
        raise ValueError("Invalid download URL: require HTTP(S) without credentials")
    params: dict[str, Any] = {"url": url, "timeoutMs": download_timeout(timeout_ms)}
    if filename is not None:
        if (not isinstance(filename, str) or not filename or len(filename.encode("utf-8")) > 255
                or re.search(r'[<>:"/\\|?*\x00-\x1f\x7f]', filename) or filename.endswith((".", " "))
                or re.match(r"(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)", filename, re.I)):
            raise ValueError("Invalid download filename: require a single portable basename")
        params["filename"] = filename
    return params


def download_id(value: Any) -> str:
    if (not isinstance(value, dict) or set(value) != {"downloadId"}
            or not isinstance(value["downloadId"], str) or not value["downloadId"]
            or len(value["downloadId"].encode("utf-8")) > 256):
        raise RuntimeError("Invalid download acknowledgement")
    return value["downloadId"]


class OpenBrowserUseDownload:
    """A download retaining its original session, turn and control epoch."""

    def __init__(self, download_id: str, call: Callable[[str, int], Any]) -> None:
        self.download_id, self._call = download_id, call

    def path(self, *, timeout_ms: int | None = None) -> str:
        value = self._call("downloadPath", download_timeout(timeout_ms))
        if (not isinstance(value, dict) or set(value) != {"path"} or not isinstance(value["path"], str)
                or not value["path"] or "\0" in value["path"]):
            raise RuntimeError("Invalid download path acknowledgement")
        return value["path"]

    def cancel(self, *, timeout_ms: int | None = None) -> None:
        value = self._call("cancelDownload", download_timeout(timeout_ms))
        if not isinstance(value, dict) or set(value) != {"cancelled"} or value["cancelled"] is not True:
            raise RuntimeError("Invalid download cancellation acknowledgement")
