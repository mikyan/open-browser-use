from __future__ import annotations

import copy
import json
import math
from typing import Any, Callable, Literal, TypedDict

NetworkWaitEvent = Literal["request", "response"]


class _RequiredMatch(TypedDict):
    url: str


class NetworkWaitMatch(_RequiredMatch, total=False):
    urlMatch: Literal["exact", "contains"]
    method: str
    status: int


class _RequiredResult(TypedDict):
    event: NetworkWaitEvent
    requestId: str
    url: str
    method: str
    resourceType: str


class NetworkWaitResult(_RequiredResult, total=False):
    frameUrl: str
    redirectedFrom: str
    status: int
    statusText: str
    truncated: bool


def _string(value: Any, maximum: int, empty: bool = False) -> bool:
    return isinstance(value, str) and (empty or bool(value)) and len(value.encode("utf-8")) <= maximum


def network_timeout(value: int | None, default: int = 10000) -> int:
    value = default if value is None else value
    if type(value) is not int or not 1 <= value <= 120000:
        raise ValueError("Network wait timeout_ms must be an integer from 1 to 120000")
    return value


def network_match(event: NetworkWaitEvent, value: NetworkWaitMatch) -> NetworkWaitMatch:
    if (not isinstance(value, dict) or set(value) - {"url", "urlMatch", "method", "status"}
            or not _string(value.get("url"), 4096)
            or ("urlMatch" in value and value["urlMatch"] not in ("exact", "contains"))
            or ("method" in value and not _string(value["method"], 128))
            or ("status" in value and (event != "response" or type(value["status"]) is not int or not 100 <= value["status"] <= 599))):
        raise ValueError("Invalid network wait match")
    return copy.deepcopy(value)


def network_ack(value: Any, timeout: int) -> tuple[str, float]:
    if (not isinstance(value, dict) or set(value) != {"waiterId", "remainingMs"}
            or not _string(value.get("waiterId"), 128)
            or type(value.get("remainingMs")) not in (int, float)
            or not math.isfinite(value["remainingMs"]) or not 0 < value["remainingMs"] <= timeout):
        raise RuntimeError("Invalid network wait ready acknowledgement")
    return value["waiterId"], value["remainingMs"]


def network_result(value: Any, event: NetworkWaitEvent) -> NetworkWaitResult:
    allowed = {"event", "requestId", "url", "method", "resourceType", "frameUrl", "redirectedFrom", "status", "statusText", "truncated"}
    if (not isinstance(value, dict) or set(value) - allowed or value.get("event") != event
            or not _string(value.get("requestId"), 128) or not _string(value.get("url"), 4096)
            or not _string(value.get("method"), 128) or not _string(value.get("resourceType"), 128)
            or ("frameUrl" in value and not _string(value["frameUrl"], 4096, True))
            or ("redirectedFrom" in value and not _string(value["redirectedFrom"], 128))
            or ("statusText" in value and not _string(value["statusText"], 1024, True))
            or ("truncated" in value and type(value["truncated"]) is not bool)
            or (event == "response" and (type(value.get("status")) is not int or not 100 <= value["status"] <= 599))
            or (event == "request" and ("status" in value or "statusText" in value))
            or len(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")) > 16384):
        raise RuntimeError("Invalid network wait result")
    return value


class OpenBrowserUseNetworkWait:
    """Ready listener bound to its original control epoch. Trigger before result()."""

    def __init__(self, waiter_id: str, remaining_ms: float, event: NetworkWaitEvent,
                 call: Callable[[str, float], Any]) -> None:
        self.waiter_id, self.remaining_ms = waiter_id, remaining_ms
        self._event, self._call = event, call

    def result(self, *, timeout_ms: int | None = None) -> NetworkWaitResult:
        timeout = network_timeout(timeout_ms, 120000)
        return network_result(self._call("collectNetworkWait", timeout / 1000 + 1), self._event)

    def cancel(self, *, timeout_ms: int | None = None) -> None:
        result = self._call("cancelNetworkWait", network_timeout(timeout_ms) / 1000 + 1)
        if not isinstance(result, dict) or result:
            raise RuntimeError("Invalid network wait cancellation acknowledgement")
