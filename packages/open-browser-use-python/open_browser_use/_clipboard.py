"""Finite clipboard values. Native decoding and authorization stay in the browser."""
from __future__ import annotations

import base64
import binascii
import json
from typing import Any, Literal, TypedDict, TYPE_CHECKING

if TYPE_CHECKING:
    from .client import OpenBrowserUseClient

MAX_CLIPBOARD_BYTES = 16 * 1024 * 1024
MAX_CLIPBOARD_JSON_BYTES = 48 * 1024 * 1024
CLIPBOARD_METHODS = frozenset({"readClipboardText", "writeClipboardText", "readClipboard", "writeClipboard"})


def _bounded_clipboard_wire(value: dict[str, Any]) -> dict[str, Any]:
    encoded = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    size = len(encoded.encode("utf-8"))
    # Include encoding/json's default HTML and line-separator escapes when
    # the Go host rewrites this message. Leave space for transport metadata.
    size += 5 * sum(encoded.count(char) for char in "<>&")
    size += 3 * sum(encoded.count(char) for char in "\u2028\u2029")
    if size > MAX_CLIPBOARD_JSON_BYTES:
        raise ValueError("OBU_CLIPBOARD_LIMIT: encoded clipboard body exceeds 48 MiB")
    return value


class ClipboardEntry(TypedDict, total=False):
    mime_type: Literal["text/plain", "text/html", "image/png"]
    text: str
    base64: str


class ClipboardItem(TypedDict, total=False):
    entries: list[ClipboardEntry]
    presentation_style: Literal["unspecified", "inline", "attachment"]


def _keys(value: Any, allowed: set[str]) -> None:
    if not isinstance(value, dict) or set(value) - allowed:
        raise ValueError("Invalid clipboard fields")


def _text_bytes(value: Any) -> int:
    if not isinstance(value, str):
        raise ValueError("Invalid clipboard UTF-8 text")
    try:
        return len(value.encode("utf-8"))
    except UnicodeEncodeError as error:
        raise ValueError("Invalid clipboard UTF-8 text") from error


def clipboard_timeout(value: Any) -> int:
    if type(value) is not int or not 1 <= value <= 120000:
        raise ValueError("Invalid clipboard timeoutMs")
    return value


def _png_bytes(value: Any, maximum: int) -> int:
    if not isinstance(value, str) or len(value) > 4 * ((maximum + 2) // 3):
        raise ValueError("Invalid clipboard PNG base64")
    try:
        data = base64.b64decode(value, validate=True)
    except (ValueError, binascii.Error) as error:
        raise ValueError("Invalid clipboard PNG base64") from error
    if (len(data) < 33 or len(data) > maximum or base64.b64encode(data).decode("ascii") != value
            or data[:8] != b"\x89PNG\r\n\x1a\n" or data[8:16] != b"\x00\x00\x00\rIHDR"):
        raise ValueError("Invalid clipboard PNG")
    width, height = int.from_bytes(data[16:20], "big"), int.from_bytes(data[20:24], "big")
    depths = {0: (1, 2, 4, 8, 16), 2: (8, 16), 3: (1, 2, 4, 8), 4: (8, 16), 6: (8, 16)}
    if (width < 1 or height < 1 or width * height > 16777216 or data[24] not in depths.get(data[25], ())
            or data[26] != 0 or data[27] != 0 or data[28] > 1):
        raise ValueError("Invalid clipboard PNG IHDR or pixel limit")
    # The trusted native adapter must still fully decode the image.
    return len(data)


def validate_clipboard_items(value: Any, maximum: int) -> list[ClipboardItem]:
    if type(maximum) is not int or not 1 <= maximum <= MAX_CLIPBOARD_BYTES:
        raise ValueError("Invalid clipboard maxBytes")
    if not isinstance(value, list) or len(value) > 1:
        raise ValueError("Clipboard items must contain at most one item")
    total, result = 0, []
    for item in value:
        _keys(item, {"entries", "presentation_style"})
        if "presentation_style" in item and item["presentation_style"] not in ("unspecified", "inline", "attachment"):
            raise ValueError("Invalid clipboard presentation_style")
        if not isinstance(item.get("entries"), list) or not 1 <= len(item["entries"]) <= 3:
            raise ValueError("Invalid clipboard entries")
        entries, seen = [], set()
        for entry in item["entries"]:
            if not isinstance(entry, dict) or not isinstance(entry.get("mime_type"), str) or entry["mime_type"] in seen:
                raise ValueError("Invalid or duplicate clipboard MIME type")
            mime = entry["mime_type"]
            seen.add(mime)
            if mime in ("text/plain", "text/html"):
                _keys(entry, {"mime_type", "text"})
                total += _text_bytes(entry.get("text"))
            elif mime == "image/png":
                _keys(entry, {"mime_type", "base64"})
                total += _png_bytes(entry.get("base64"), maximum)
            else:
                raise ValueError("Unsupported clipboard MIME type")
            if total > maximum:
                raise ValueError("Clipboard byte limit exceeded")
            entries.append(dict(entry))
        copied = {"entries": entries}
        if "presentation_style" in item:
            copied["presentation_style"] = item["presentation_style"]
        result.append(copied)
    return result


def clipboard_params(method: str, tab_id: int, payload: dict[str, Any], max_bytes: int | None, timeout_ms: int | None) -> dict[str, Any]:
    if method not in CLIPBOARD_METHODS or type(tab_id) is not int or not 0 <= tab_id <= 9007199254740991:
        raise ValueError("Invalid clipboard request")
    maximum = MAX_CLIPBOARD_BYTES if max_bytes is None else max_bytes
    if type(maximum) is not int or not 1 <= maximum <= MAX_CLIPBOARD_BYTES:
        raise ValueError("Invalid clipboard maxBytes")
    result = {"tabId": tab_id, "maxBytes": maximum, "timeoutMs": clipboard_timeout(10000 if timeout_ms is None else timeout_ms)}
    _keys(payload, {"text"} if method == "writeClipboardText" else {"items"} if method == "writeClipboard" else set())
    if method == "writeClipboardText":
        if _text_bytes(payload.get("text")) > maximum:
            raise ValueError("Clipboard byte limit exceeded")
        result["text"] = payload["text"]
    elif method == "writeClipboard":
        result["items"] = validate_clipboard_items(payload.get("items"), maximum)
    return _bounded_clipboard_wire(result)


def validate_clipboard_result(method: str, value: Any, maximum: int) -> dict[str, Any]:
    if type(maximum) is not int or not 1 <= maximum <= MAX_CLIPBOARD_BYTES:
        raise ValueError("Invalid clipboard maxBytes")
    if method == "readClipboardText":
        _keys(value, {"text"})
        if _text_bytes(value.get("text")) > maximum:
            raise ValueError("Clipboard byte limit exceeded")
        return _bounded_clipboard_wire({"text": value["text"]})
    if method == "readClipboard":
        _keys(value, {"items"})
        return _bounded_clipboard_wire({"items": validate_clipboard_items(value.get("items"), maximum)})
    if method not in {"writeClipboard", "writeClipboardText"}:
        raise ValueError("Invalid clipboard method")
    _keys(value, set())
    return {}


class OpenBrowserUseClipboard:
    def __init__(self, client: OpenBrowserUseClient, tab_id: int):
        self._client, self._tab_id = client, tab_id

    def read_text(self, *, max_bytes: int | None = None, timeout_ms: int | None = None) -> str:
        return self._client.read_clipboard_text(self._tab_id, max_bytes=max_bytes, timeout_ms=timeout_ms)["text"]

    def write_text(self, text: str, *, max_bytes: int | None = None, timeout_ms: int | None = None) -> None:
        self._client.write_clipboard_text(self._tab_id, text, max_bytes=max_bytes, timeout_ms=timeout_ms)

    def read(self, *, max_bytes: int | None = None, timeout_ms: int | None = None) -> list[ClipboardItem]:
        return self._client.read_clipboard(self._tab_id, max_bytes=max_bytes, timeout_ms=timeout_ms)["items"]

    def write(self, items: list[ClipboardItem], *, max_bytes: int | None = None, timeout_ms: int | None = None) -> None:
        self._client.write_clipboard(self._tab_id, items, max_bytes=max_bytes, timeout_ms=timeout_ms)
