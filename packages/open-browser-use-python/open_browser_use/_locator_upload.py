"""Bounded native file paths; no filesystem access or cwd resolution."""

import re
from typing import Any


def locator_upload_params(params: dict[str, Any]) -> None:
    args = params.get("args")
    if not isinstance(args, dict) or set(args) != {"files"}:
        raise ValueError("setInputFiles requires only args.files")
    files = args["files"]
    if not isinstance(files, list) or len(files) > 1024:
        raise ValueError("setInputFiles files must be an array of at most 1024 absolute paths")
    total = 0
    for path in files:
        if (not isinstance(path, str) or not path or "\0" in path or not
                (path.startswith("/") or re.match(r"^[A-Za-z]:[\\/]", path)
                 or re.match(r"^\\\\[^\\/]+[\\/][^\\/]+(?:[\\/]|$)", path))):
            raise ValueError("setInputFiles requires nonempty absolute UTF-8 paths without NUL")
        try:
            size = len(path.encode("utf-8"))
        except UnicodeEncodeError as error:
            raise ValueError("setInputFiles requires valid UTF-8 paths") from error
        total += size
        if size > 131072 or total > 8 * 1024 * 1024:
            raise ValueError("setInputFiles path byte limit exceeded")
    timeout = params.get("timeoutMs", 10000)
    if type(timeout) is not int or not 1 <= timeout <= 120000:
        raise ValueError("setInputFiles timeoutMs must be an integer from 1 to 120000")


def require_locator_upload(response: Any) -> None:
    engine = response.get("engine") if isinstance(response, dict) else None
    capabilities = engine.get("capabilities") if isinstance(engine, dict) else None
    version = capabilities.get("locatorFileUpload") if isinstance(capabilities, dict) else None
    if (not isinstance(response, dict) or "value" not in response or not isinstance(engine, dict)
            or engine.get("name") != "playwright-crx"
            or not all(isinstance(engine.get(key), str) for key in ("version", "playwrightVersion"))
            or type(version) is not int or version != 1):
        raise RuntimeError("OBU_LOCATOR_FILE_UPLOAD_UNSUPPORTED: extension does not advertise engine.capabilities.locatorFileUpload 1")
