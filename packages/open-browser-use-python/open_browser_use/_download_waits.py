from __future__ import annotations

import math
import threading
import time
from typing import Any, Callable

from ._downloads import OpenBrowserUseDownload, download_id


DOWNLOAD_WAIT_METHODS = frozenset({"armDownloadWait", "collectDownloadWait", "cancelDownloadWait"})


def _identifier(value: Any) -> bool:
    return isinstance(value, str) and bool(value) and len(value.encode("utf-8")) <= 128


def download_wait_timeout(value: int | None = None) -> int:
    timeout = 10000 if value is None else value
    if type(timeout) is not int or not 1 <= timeout <= 120000:
        raise ValueError("Download wait timeout_ms must be an integer from 1 to 120000")
    return timeout


def download_wait_params(method: str, params: dict[str, Any]) -> None:
    allowed = {"session_id", "turn_id", "control_epoch", "tabId", "timeoutMs" if method == "armDownloadWait" else "waiterId"}
    if (not isinstance(params, dict) or set(params) - allowed or type(params.get("tabId")) is not int
            or not 0 <= params["tabId"] <= 9007199254740991
            or (method != "armDownloadWait" and not _identifier(params.get("waiterId")))):
        raise ValueError("Invalid download wait parameters")
    for key in ("session_id", "turn_id"):
        if key in params and (not isinstance(params[key], str) or not params[key] or len(params[key].encode("utf-8")) > 4096):
            raise ValueError("Invalid download wait scope")
    if "control_epoch" in params and (type(params["control_epoch"]) is not int or not 1 <= params["control_epoch"] <= 9007199254740991):
        raise ValueError("Invalid download wait scope")
    if method == "armDownloadWait":
        if "timeoutMs" in params and params["timeoutMs"] is None:
            raise ValueError("Download wait timeoutMs cannot be null")
        download_wait_timeout(params.get("timeoutMs"))


def download_wait_ack(value: Any, timeout: float) -> tuple[str, float]:
    if (not isinstance(value, dict) or set(value) != {"waiterId", "remainingMs"}
            or not _identifier(value.get("waiterId")) or type(value.get("remainingMs")) not in (int, float)
            or not math.isfinite(value["remainingMs"]) or not 0 < value["remainingMs"] <= timeout):
        raise RuntimeError("Invalid download wait ready acknowledgement")
    return value["waiterId"], value["remainingMs"]


def download_wait_cancelled(value: Any) -> None:
    if not isinstance(value, dict) or value:
        raise RuntimeError("Invalid download wait cancellation acknowledgement")


def download_wait_remaining(deadline: float) -> float:
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise TimeoutError("Download wait deadline expired; request was not sent")
    return remaining


class OpenBrowserUseDownloadWait:
    """Observes one page download; cancel() does not cancel an actual transfer."""

    def __init__(self, waiter_id: str, remaining_ms: float, deadline: float,
                 call: Callable[[str, float, float | None], Any],
                 download: Callable[[str], OpenBrowserUseDownload]) -> None:
        self.waiter_id, self.remaining_ms = waiter_id, remaining_ms
        self._deadline, self._call, self._download = deadline, call, download
        self._collecting = threading.Lock()
        self._finished = False

    def result(self) -> OpenBrowserUseDownload:
        if not self._collecting.acquire(blocking=False):
            raise RuntimeError("OBU_DOWNLOAD_WAIT_CONFLICT: result is already pending")
        try:
            if self._finished:
                raise RuntimeError("OBU_DOWNLOAD_WAIT_INVALID: wait has already been consumed or cancelled")
            identifier = download_id(self._call("collectDownloadWait", download_wait_remaining(self._deadline) + 1, self._deadline))
            self._finished = True
            return self._download(identifier)
        finally:
            self._collecting.release()

    def cancel(self) -> None:
        # Cleanup remains retryable after expiry, without extending observation.
        download_wait_cancelled(self._call("cancelDownloadWait", 10, None))
        self._finished = True
