"""Bounded encoded page exports; callers choose whether and where to save."""

from __future__ import annotations

import base64
import binascii
import math
from typing import Any, Literal, TypedDict, cast

ExportFormat = Literal["pdf", "mhtml"]
MAX_PAGE_EXPORT_BYTES = 16 * 1024 * 1024
MIME_TYPES = {"pdf": "application/pdf", "mhtml": "multipart/related"}


class PDFOptions(TypedDict, total=False):
    landscape: bool
    printBackground: bool
    scale: float
    paperWidth: float
    paperHeight: float
    marginTop: float
    marginBottom: float
    marginLeft: float
    marginRight: float
    pageRanges: str
    preferCSSPageSize: bool
    generateTaggedPDF: bool
    generateDocumentOutline: bool


class PageExport(TypedDict):
    format: ExportFormat
    mimeType: Literal["application/pdf", "multipart/related"]
    encoding: Literal["base64"]
    data: str
    byteLength: int


def export_timeout(value: Any) -> int:
    if type(value) is not int or not 1 <= value <= 120000:
        raise ValueError("Page export timeout_ms must be an integer from 1 to 120000")
    return value


def export_params(format: ExportFormat, max_bytes: int | None, timeout_ms: int | None,
                  pdf: PDFOptions | None) -> dict[str, Any]:
    if format not in ("pdf", "mhtml"):
        raise ValueError("Invalid page export format")
    maximum = MAX_PAGE_EXPORT_BYTES if max_bytes is None else max_bytes
    if type(maximum) is not int or not 1 <= maximum <= MAX_PAGE_EXPORT_BYTES:
        raise ValueError("Page export max_bytes must be an integer from 1 to 16777216")
    params: dict[str, Any] = {"format": format, "maxBytes": maximum,
                              "timeoutMs": export_timeout(10000 if timeout_ms is None else timeout_ms)}
    if pdf is not None:
        if format != "pdf" or not isinstance(pdf, dict):
            raise ValueError("PDF options require format pdf and a dictionary")
        copied = {}
        for key, value in pdf.items():
            if key in {"landscape", "printBackground", "preferCSSPageSize", "generateTaggedPDF", "generateDocumentOutline"}:
                if type(value) is not bool:
                    raise ValueError(f"Invalid PDF option: {key}")
            elif key in {"scale", "paperWidth", "paperHeight", "marginTop", "marginBottom", "marginLeft", "marginRight"}:
                minimum, maximum_value = (0.1, 2) if key == "scale" else (0, 200)
                if (type(value) not in (int, float) or not math.isfinite(value)
                        or not minimum <= value <= maximum_value or (key.startswith("paper") and value == 0)):
                    raise ValueError(f"Invalid PDF option: {key}")
            elif key == "pageRanges":
                if not isinstance(value, str) or len(value) > 1024 or any(c not in "0123456789,- " for c in value):
                    raise ValueError("Invalid PDF pageRanges")
            else:
                raise ValueError(f"Invalid PDF option: {key}")
            copied[key] = value
        params["pdf"] = copied
    return params


def validate_export(value: Any, format: ExportFormat, max_bytes: int) -> PageExport:
    invalid = RuntimeError("Invalid exportPage result")
    if (not isinstance(value, dict) or set(value) != {"format", "mimeType", "encoding", "data", "byteLength"}
            or value["format"] != format or value["mimeType"] != MIME_TYPES[format] or value["encoding"] != "base64"
            or type(value["byteLength"]) is not int or not 1 <= value["byteLength"] <= max_bytes
            or not isinstance(value["data"], str) or len(value["data"]) > 4 * ((max_bytes + 2) // 3)
            or len(value["data"]) != 4 * ((value["byteLength"] + 2) // 3)):
        raise invalid
    try:
        decoded = base64.b64decode(value["data"], validate=True)
    except (ValueError, binascii.Error) as error:
        raise invalid from error
    if len(decoded) != value["byteLength"] or base64.b64encode(decoded).decode("ascii") != value["data"]:
        raise invalid
    return cast(PageExport, dict(value))
