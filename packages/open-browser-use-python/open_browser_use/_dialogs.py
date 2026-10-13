from __future__ import annotations

import math
import threading
from typing import Any, Callable, Literal, TypedDict

from ._page_waits import page_wait_timeout, page_wait_remaining

DialogType = Literal["alert", "confirm", "prompt", "beforeunload"]
class _RequiredDialogDecision(TypedDict):
    type: DialogType
    accept: bool
class DialogDecision(_RequiredDialogDecision, total=False):
    message: str
    promptText: str

class _RequiredDialogResult(TypedDict):
    type: DialogType
    message: str
    defaultValue: str
    accepted: bool
class DialogResult(_RequiredDialogResult, total=False):
    promptText: str

DIALOG_METHODS = frozenset({"armDialog", "collectDialog", "cancelDialog"})
_TYPES = frozenset({"alert", "confirm", "prompt", "beforeunload"})

def _text(value: Any, limit: int = 8192, empty: bool = True) -> bool:
    if not isinstance(value, str) or not empty and not value:
        return False
    try:
        return len(value.encode("utf-8")) <= limit
    except UnicodeEncodeError:
        return False

def dialog_decision(value: Any) -> None:
    if (not isinstance(value, dict) or set(value) - {"type", "accept", "message", "promptText"}
            or not isinstance(value.get("type"), str) or value["type"] not in _TYPES or type(value.get("accept")) is not bool
            or "message" in value and not _text(value["message"])
            or "promptText" in value and (not _text(value["promptText"]) or value["type"] != "prompt" or value["accept"] is not True)):
        raise ValueError("Invalid native dialog decision")

def dialog_params(method: str, params: dict[str, Any]) -> None:
    arm = method == "armDialog"
    allowed = {"session_id", "turn_id", "control_epoch", "tabId"} | ({"type", "accept", "message", "promptText", "timeoutMs"} if arm else {"dialogId"})
    if (method not in DIALOG_METHODS or not isinstance(params, dict) or set(params) - allowed
            or type(params.get("tabId")) is not int or not 0 <= params["tabId"] <= 9007199254740991):
        raise ValueError("Invalid native dialog parameters")
    for key in ("session_id", "turn_id"):
        if key in params and not _text(params[key], 4096, False):
            raise ValueError("Invalid native dialog scope")
    if "control_epoch" in params and (type(params["control_epoch"]) is not int or not 1 <= params["control_epoch"] <= 9007199254740991):
        raise ValueError("Invalid native dialog scope")
    if arm:
        dialog_decision({key: params[key] for key in ("type", "accept", "message", "promptText") if key in params})
        if "timeoutMs" in params and params["timeoutMs"] is None:
            raise ValueError("Dialog timeoutMs cannot be null")
        page_wait_timeout(params.get("timeoutMs"))
    elif not _text(params.get("dialogId"), 128, False):
        raise ValueError("Invalid native dialog ID")

def dialog_ack(value: Any, timeout: float) -> tuple[str, float]:
    if (not isinstance(value, dict) or set(value) != {"dialogId", "remainingMs"} or not _text(value.get("dialogId"), 128, False)
            or type(value.get("remainingMs")) not in (int, float) or not math.isfinite(value["remainingMs"]) or not 0 < value["remainingMs"] <= timeout):
        raise RuntimeError("Invalid native dialog ready acknowledgement")
    return value["dialogId"], value["remainingMs"]

def dialog_result(value: Any) -> DialogResult:
    if (not isinstance(value, dict) or set(value) - {"type", "message", "defaultValue", "accepted", "promptText"}
            or not isinstance(value.get("type"), str) or value["type"] not in _TYPES or not _text(value.get("message"))
            or not _text(value.get("defaultValue")) or type(value.get("accepted")) is not bool
            or (not _text(value.get("promptText")) if value.get("type") == "prompt" and value.get("accepted") is True else "promptText" in value)):
        raise RuntimeError("Invalid native dialog result")
    return value

def dialog_cancelled(value: Any) -> None:
    if not isinstance(value, dict) or value:
        raise RuntimeError("Invalid native dialog cancellation acknowledgement")

class OpenBrowserUseDialogWait:
    """One original native decision; cancellation cannot undo a sent response."""
    def __init__(self, dialog_id: str, remaining_ms: float, deadline: float,
                 call: Callable[[str, float, float | None], Any], decision: DialogDecision) -> None:
        self.dialog_id, self.remaining_ms = dialog_id, remaining_ms
        self._deadline, self._call = deadline, call
        self._decision = dict(decision)
        self._collecting = threading.Lock()
        self._finished = False

    def result(self) -> DialogResult:
        if not self._collecting.acquire(blocking=False):
            raise RuntimeError("OBU_DIALOG_BUSY: result is already pending")
        try:
            if self._finished:
                raise RuntimeError("OBU_DIALOG_EXPIRED: decision has already been consumed or cancelled")
            result = dialog_result(self._call("collectDialog", page_wait_remaining(self._deadline), self._deadline))
            if (result["type"] != self._decision["type"] or result["accepted"] != self._decision["accept"]
                    or "message" in self._decision and result["message"] != self._decision["message"]
                    or result["type"] == "prompt" and result["accepted"] and result["promptText"] != self._decision.get("promptText", "")):
                raise RuntimeError("Native dialog result differs from original decision")
            page_wait_remaining(self._deadline)
            self._finished = True
            return result
        finally:
            self._collecting.release()

    def cancel(self) -> None:
        dialog_cancelled(self._call("cancelDialog", 10, None))
        self._finished = True
