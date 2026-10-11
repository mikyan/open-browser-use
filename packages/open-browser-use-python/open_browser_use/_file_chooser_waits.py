from __future__ import annotations

import math
import threading
import time
from typing import Any, Callable, TypedDict


class FileChooserWaitResult(TypedDict):
    fileChooserId: str
    isMultiple: bool


FILE_CHOOSER_WAIT_METHODS = frozenset({"armFileChooserWait", "collectFileChooserWait", "cancelFileChooserWait"})


def _identifier(value: Any) -> bool:
    return isinstance(value, str) and bool(value) and len(value.encode("utf-8")) <= 128


def file_chooser_timeout(value: int | None = None) -> int:
    timeout = 10000 if value is None else value
    if type(timeout) is not int or not 1 <= timeout <= 120000:
        raise ValueError("File chooser wait timeout_ms must be an integer from 1 to 120000")
    return timeout


def file_chooser_params(method: str, params: dict[str, Any]) -> None:
    allowed = {"session_id", "turn_id", "control_epoch", "tabId", "timeoutMs" if method == "armFileChooserWait" else "waiterId"}
    if (not isinstance(params, dict) or set(params) - allowed or type(params.get("tabId")) is not int
            or not 0 <= params["tabId"] <= 9007199254740991
            or (method != "armFileChooserWait" and not _identifier(params.get("waiterId")))):
        raise ValueError("Invalid file chooser wait parameters")
    if method == "armFileChooserWait":
        if "timeoutMs" in params and params["timeoutMs"] is None:
            raise ValueError("File chooser wait timeoutMs cannot be null")
        file_chooser_timeout(params.get("timeoutMs"))


def file_chooser_ack(value: Any, timeout: float) -> tuple[str, float]:
    if (not isinstance(value, dict) or set(value) != {"waiterId", "remainingMs"}
            or not _identifier(value.get("waiterId")) or type(value.get("remainingMs")) not in (int, float)
            or not math.isfinite(value["remainingMs"]) or not 0 < value["remainingMs"] <= timeout):
        raise RuntimeError("Invalid file chooser wait ready acknowledgement")
    return value["waiterId"], value["remainingMs"]


def file_chooser_result(value: Any) -> FileChooserWaitResult:
    if (not isinstance(value, dict) or set(value) != {"fileChooserId", "isMultiple"}
            or not _identifier(value.get("fileChooserId")) or type(value.get("isMultiple")) is not bool):
        raise RuntimeError("Invalid file chooser wait result")
    return {"fileChooserId": value["fileChooserId"], "isMultiple": value["isMultiple"]}


def file_chooser_cancelled(value: Any) -> None:
    if not isinstance(value, dict) or value:
        raise RuntimeError("Invalid file chooser wait cancellation acknowledgement")


def file_chooser_remaining(deadline: float) -> float:
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise TimeoutError("File chooser wait deadline expired; request was not sent")
    return remaining


class OpenBrowserUseFileChooserWait:
    """Ready before the triggering click; retains its original scope and deadline."""

    def __init__(self, waiter_id: str, remaining_ms: float, deadline: float,
                 call: Callable[[str, float, float | None], Any]) -> None:
        self.waiter_id, self.remaining_ms = waiter_id, remaining_ms
        self._deadline, self._call = deadline, call
        self._collecting = threading.Lock()

    def result(self) -> FileChooserWaitResult:
        if not self._collecting.acquire(blocking=False):
            raise RuntimeError("OBU_FILE_CHOOSER_WAIT_CONFLICT: result is already pending")
        try:
            return file_chooser_result(self._call("collectFileChooserWait", file_chooser_remaining(self._deadline) + 1, self._deadline))
        finally:
            self._collecting.release()

    def cancel(self) -> None:
        # Cleanup remains possible after expiry, without extending the wait.
        file_chooser_cancelled(self._call("cancelFileChooserWait", 10, None))
