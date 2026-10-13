"""Original diagnostic response bytes; this module never fetches a URL."""
import base64
import binascii
from typing import Any, Literal, TypedDict

MAX_RESPONSE_BODY_BYTES = 8 * 1024 * 1024
DEFAULT_RESPONSE_BODY_BYTES = 1024 * 1024


class ResponseBody(TypedDict):
    captureId: str
    requestId: str
    encoding: Literal["base64"]
    data: str
    byteLength: int


def _identifier(value: Any) -> bool:
    try:
        return isinstance(value, str) and 0 < len(value.encode("utf-8", errors="strict")) <= 128
    except UnicodeError:
        return False


def response_body_params(capture_id: str, request_id: str, max_bytes: int | None = None,
                         timeout_ms: int | None = None) -> dict[str, Any]:
    maximum = DEFAULT_RESPONSE_BODY_BYTES if max_bytes is None else max_bytes
    timeout = 10000 if timeout_ms is None else timeout_ms
    if (not _identifier(capture_id) or not _identifier(request_id)
            or type(maximum) is not int or not 1 <= maximum <= MAX_RESPONSE_BODY_BYTES
            or type(timeout) is not int or not 1 <= timeout <= 120000):
        raise ValueError("OBU_RESPONSE_BODY_INVALID: invalid response body reference or options")
    return {"args": {"captureId": capture_id, "requestId": request_id, "maxBytes": maximum}, "timeoutMs": timeout}


def response_body_request(params: dict[str, Any]) -> dict[str, Any]:
    args = params.get("args")
    if (set(params) - {"session_id", "turn_id", "control_epoch", "tabId", "action", "args", "timeoutMs"}
            or type(params.get("tabId")) is not int or not 0 <= params["tabId"] <= 9007199254740991
            or params.get("action") != "responseBody" or not isinstance(args, dict)
            or set(args) - {"captureId", "requestId", "maxBytes"}
            or ("maxBytes" in args and args["maxBytes"] is None)
            or ("timeoutMs" in params and params["timeoutMs"] is None)):
        raise ValueError("OBU_RESPONSE_BODY_INVALID: invalid response body request")
    return response_body_params(args.get("captureId"), args.get("requestId"), args.get("maxBytes"), params.get("timeoutMs"))


def validate_response_body(value: Any, capture_id: str, request_id: str, maximum: int) -> ResponseBody:
    failure = RuntimeError("OBU_RESPONSE_BODY_FAILED: invalid response body result")
    if (not isinstance(value, dict) or set(value) != {"captureId", "requestId", "encoding", "data", "byteLength"}
            or value["captureId"] != capture_id or value["requestId"] != request_id or value["encoding"] != "base64"
            or not isinstance(value["data"], str) or type(value["byteLength"]) is not int
            or not 0 <= value["byteLength"] <= maximum
            or len(value["data"]) > 4 * ((maximum + 2) // 3)
            or len(value["data"]) != 4 * ((value["byteLength"] + 2) // 3)):
        raise failure
    try:
        decoded = base64.b64decode(value["data"], validate=True)
    except (ValueError, binascii.Error):
        raise failure from None
    if len(decoded) != value["byteLength"] or base64.b64encode(decoded).decode("ascii") != value["data"]:
        raise failure
    return dict(value)


def validate_response_body_envelope(result: Any, params: dict[str, Any]) -> None:
    args = response_body_request(params)["args"]
    engine = result.get("engine") if isinstance(result, dict) else None
    capabilities = engine.get("capabilities") if isinstance(engine, dict) else None
    if (not isinstance(engine, dict) or engine.get("name") != "playwright-crx"
            or not isinstance(engine.get("version"), str) or not isinstance(engine.get("playwrightVersion"), str)):
        raise RuntimeError("OBU_RESPONSE_BODY_FAILED: invalid response body envelope")
    if (not isinstance(capabilities, dict) or type(capabilities.get("responseBody")) is not int or capabilities["responseBody"] != 1):
        raise RuntimeError("OBU_RESPONSE_BODY_UNSUPPORTED: extension engine does not advertise responseBody 1")
    validate_response_body(result.get("value"), args["captureId"], args["requestId"], args["maxBytes"])
