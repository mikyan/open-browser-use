from __future__ import annotations

import math
from typing import Any, Callable, Literal

NavigationLoadState = Literal["load", "domcontentloaded", "networkidle"]
NavigationWaitUntil = Literal["load", "domcontentloaded", "networkidle", "commit"]


def navigation_timeout(value: int | None, default: int = 10000) -> int:
    value = default if value is None else value
    if type(value) is not int or not 1 <= value <= 120000:
        raise ValueError("Navigation wait timeout_ms must be an integer from 1 to 120000")
    return value


def navigation_params(event: str, url: str | None, state: str, timeout_ms: int | None) -> dict[str, Any]:
    params: dict[str, Any] = {"event": event, "timeoutMs": navigation_timeout(timeout_ms)}
    if event == "url":
        if not isinstance(url, str) or not url or len(url.encode("utf-8")) > 4096 or state not in ("load", "domcontentloaded", "networkidle", "commit"):
            raise ValueError("Invalid navigation URL or wait_until")
        params.update(url=url, waitUntil=state)
    elif event == "loadstate" and state in ("load", "domcontentloaded", "networkidle"):
        params["state"] = state
    else:
        raise ValueError("Invalid navigation load state")
    return params


def navigation_ack(value: Any, timeout: int) -> tuple[str, float]:
    if (not isinstance(value, dict) or set(value) != {"waiterId", "remainingMs"}
            or not isinstance(value.get("waiterId"), str) or not value["waiterId"] or len(value["waiterId"].encode("utf-8")) > 128
            or type(value.get("remainingMs")) not in (int, float) or not math.isfinite(value["remainingMs"])
            or not 0 < value["remainingMs"] <= timeout):
        raise RuntimeError("Invalid navigation wait ready acknowledgement")
    return value["waiterId"], value["remainingMs"]


class OpenBrowserUseNavigationWait:
    """Ready observer bound to its original epoch. Trigger before result()."""

    def __init__(self, waiter_id: str, remaining_ms: float, call: Callable[[str, float], Any]) -> None:
        self.waiter_id, self.remaining_ms, self._call = waiter_id, remaining_ms, call

    def result(self, *, timeout_ms: int | None = None) -> None:
        self._empty(self._call("collectNavigationWait", navigation_timeout(timeout_ms, 120000) / 1000 + 1))

    def cancel(self, *, timeout_ms: int | None = None) -> None:
        self._empty(self._call("cancelNavigationWait", navigation_timeout(timeout_ms) / 1000 + 1))

    @staticmethod
    def _empty(value: Any) -> None:
        if not isinstance(value, dict) or value:
            raise RuntimeError("Invalid navigation wait acknowledgement")
