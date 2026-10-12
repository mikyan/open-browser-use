"""One owned Page download through the public typed Python SDK; no replay."""
import base64
import hashlib
import json
import os
from pathlib import Path
import stat
import sys
import time
import uuid

from open_browser_use import OpenBrowserUseBrowser, OpenBrowserUseClient


MAX_FILE_BYTES = 65536
FIELDS = {"socketPath", "sessionId", "turnId", "controlEpoch", "tabId", "variant", "key", "kind", "readyGate"}


def repository_tmp():
    directory = Path.cwd()
    for candidate in (directory, *directory.parents):
        if (candidate / "go.mod").is_file():
            return (candidate / ".tmp").resolve(strict=True)
    raise ValueError("Repository .tmp directory not found")


def validate_gate(gate):
    require(isinstance(gate, dict) and set(gate) == {"readyPath", "releasePath", "token"}, "Invalid readyGate fields")
    token = gate["token"]
    require(isinstance(token, str) and 1 <= len(token.encode("utf-8")) <= 256
            and all(ord(char) > 32 and ord(char) != 127 for char in token), "Invalid readyGate token")
    temporary = repository_tmp()
    parents = []
    for field in ("readyPath", "releasePath"):
        value = gate[field]
        require(isinstance(value, str) and bool(value) and "\0" not in value, f"Invalid {field}")
        path = Path(value)
        require(path.is_absolute(), f"{field} must be absolute")
        parent = path.parent.resolve(strict=True)
        require(parent != temporary and parent.is_relative_to(temporary), "Ready gate must stay in a dedicated repository .tmp directory")
        require(not path.exists() and not path.is_symlink(), "Ready gate paths must be fresh")
        parents.append(parent)
    require(parents[0] == parents[1] and Path(gate["readyPath"]) != Path(gate["releasePath"]), "Ready gate paths must be distinct files in the same run directory")


def await_ready_gate(gate, detail, deadline):
    require(time.monotonic() < deadline, "Ready gate deadline expired before publication")
    record = {key: detail[key] for key in ("waiterId", "remainingMs", "readyAt", "scope", "tabId")}
    record["token"] = gate["token"]
    with Path(gate["readyPath"]).open("x", encoding="utf-8", newline="\n") as ready:
        ready.write(json.dumps(record, ensure_ascii=False) + "\n")
    token = gate["token"].encode("utf-8")
    while time.monotonic() < deadline:
        try:
            info = os.lstat(gate["releasePath"])
        except FileNotFoundError:
            time.sleep(min(0.025, max(0, deadline - time.monotonic())))
            continue
        require(stat.S_ISREG(info.st_mode), "Ready gate release is not a regular file")
        flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(gate["releasePath"], flags)
        with os.fdopen(descriptor, "rb") as release:
            require(stat.S_ISREG(os.fstat(release.fileno()).st_mode), "Ready gate release changed type")
            content = release.read(257)
        require(content == token, "Ready gate release token mismatch")
        require(time.monotonic() < deadline, "Ready gate deadline expired before release")
        detail["releaseObservedAt"] = time.time_ns() // 1000000
        return
    raise TimeoutError("Ready gate deadline expired; no download input submitted")


def remaining_action_timeout(deadline):
    milliseconds = int((deadline - time.monotonic()) * 1000)
    if milliseconds < 1:
        raise TimeoutError("Original download wait deadline expired; no further input submitted")
    return min(5000, milliseconds)


def require(condition, message):
    if not condition:
        raise ValueError(message)


def validate_input(value):
    require(isinstance(value, dict) and set(value) == FIELDS, "Invalid helper input fields")
    for name in ("socketPath", "sessionId", "turnId", "key"):
        require(isinstance(value[name], str) and 0 < len(value[name]) <= 4096, f"Invalid {name}")
    require(type(value["controlEpoch"]) is int and 1 <= value["controlEpoch"] <= 9007199254740991, "Invalid controlEpoch")
    require(type(value["tabId"]) is int and 0 <= value["tabId"] <= 9007199254740991, "Invalid tabId")
    require(value["variant"] in ("root", "oopif", "dynamic-oopif"), "Invalid variant")
    require(value["kind"] in ("post", "blob"), "Invalid kind")
    validate_gate(value["readyGate"])
    return value


def check_scope(value, expected):
    require(isinstance(value, dict) and type(value.get("lifecycleVersion")) is int and value["lifecycleVersion"] == 1,
            "Invalid scope lifecycle")
    require(type(value.get("controlEpoch")) is int and value["controlEpoch"] == expected["controlEpoch"], "Control epoch changed")
    require(value.get("closing") is False, "Original turn is closing or lacks a closing state")
    require(isinstance(value.get("nextTurnId"), str) and bool(value["nextTurnId"]), "Missing nextTurnId")
    return value


def state_text(value):
    require(isinstance(value, str), "Missing original Page state")
    state = json.loads(value)
    require(isinstance(state, dict), "Invalid original Page state")
    return state


def check_initial_page(page, config):
    require(page.get("key") == config["key"] and page.get("kind") == config["kind"], "Wrong original Page")
    require(page.get("clicks") == [] and page.get("frameAdds") == [], "Fixture was already used")
    return page


def read_original_file(path):
    require(isinstance(path, str) and bool(path) and Path(path).is_absolute() and "\0" not in path, "SDK path must be absolute")
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NONBLOCK", 0)
    descriptor = os.open(path, flags)
    try:
        info = os.fstat(descriptor)
        require(stat.S_ISREG(info.st_mode) and 0 < info.st_size <= MAX_FILE_BYTES, "Original file must be ordinary and bounded")
        with os.fdopen(descriptor, "rb") as handle:
            descriptor = None
            content = handle.read(MAX_FILE_BYTES + 1)
        require(len(content) == info.st_size and len(content) <= MAX_FILE_BYTES, "Original file size changed or exceeds limit")
    finally:
        if descriptor is not None:
            os.close(descriptor)
    require(b"\n" in content, "Original file lacks its JSON header")
    analysis = json.loads(content.split(b"\n", 1)[0].decode("utf-8", errors="strict"))
    require(isinstance(analysis, dict) and set(analysis) == {"key", "kind", "owner", "nonce"}, "Invalid original file JSON header")
    for name in analysis:
        require(isinstance(analysis[name], str) and bool(analysis[name]), f"Invalid file {name}")
    require(str(uuid.UUID(analysis["nonce"])) == analysis["nonce"], "Invalid original file nonce")
    return {"bytes": len(content), "sha256": hashlib.sha256(content).hexdigest(),
            "base64": base64.b64encode(content).decode("ascii"), "analysis": analysis}


def check_evidence(detail, config):
    page, file = detail["page"], detail["file"]
    require(page.get("key") == config["key"] and page.get("kind") == config["kind"], "Download came from another Page")
    require(isinstance(page.get("owner"), str) and bool(page["owner"]), "Missing Page owner")
    clicks = page.get("clicks")
    require(isinstance(clicks, list) and len(clicks) == 1 and isinstance(clicks[0], dict), "Expected exactly one download click")
    click = clicks[0]
    require(click.get("trusted") is True and type(click.get("buttonCount")) is int and click["buttonCount"] == 1, "Download click was not the sole trusted click")
    require(isinstance(page.get("documentToken"), str) and bool(page["documentToken"])
            and click.get("documentToken") == page["documentToken"], "Original document identity changed")
    if config["kind"] == "blob":
        require(click.get("revoked") is True and isinstance(click.get("blobURL"), str)
                and click["blobURL"].startswith("blob:") and page.get("blobURL") == click["blobURL"], "Missing revoked original Blob witness")
    require(file["analysis"]["key"] == config["key"] and file["analysis"]["kind"] == config["kind"]
            and file["analysis"]["owner"] == page["owner"], "Original file owner or case mismatch")
    require(page.get("expectedSHA") == file["sha256"], "Original Page/file digest mismatch")
    if config["variant"] == "dynamic-oopif":
        root = detail["rootPage"]
        require(root.get("key") == config["key"] and root.get("kind") == config["kind"]
                and root.get("frameAdds") == [{"trusted": True}] and root.get("clicks") == [], "Dynamic frame was not added exactly once after readiness")


def run(config):
    detail = {"caller": "python", "stages": [], "waitCleanup": {"attempted": False, "ok": False}, "ok": False}
    browser = wait = None
    now = lambda: time.time_ns() // 1000000

    def stage(name, operation):
        record = {"name": name, "startedAt": now(), "ok": False}
        detail["stages"].append(record)
        try:
            result = operation()
            record["ok"] = True
            return result
        except Exception as error:
            failure = {"stage": name, "type": type(error).__name__, "message": str(error)}
            record["error"] = failure
            detail.setdefault("error", failure)
            raise
        finally:
            record["finishedAt"] = now()

    try:
        stage("input", lambda: validate_input(config))
        scope = {"session_id": config["sessionId"], "turn_id": config["turnId"], "control_epoch": config["controlEpoch"]}
        detail.update({"scope": scope, **{key: config[key] for key in ("tabId", "variant", "kind", "key")}})
        browser = OpenBrowserUseBrowser(OpenBrowserUseClient(config["socketPath"], session_id=config["sessionId"], turn_id=config["turnId"], timeout=15))
        stage("connect", browser.connect)
        tab = browser.tab(config["tabId"])
        detail["scopeBefore"] = stage("scopeBefore", lambda: check_scope(browser.client.request("getControlState", scope), config))
        detail["rootBefore"] = stage("rootBefore", lambda: check_initial_page(state_text(tab.locator("#state").text_content(timeout_ms=5000)), config))
        detail["scopeAfter"] = stage("scopeAfter", lambda: check_scope(browser.client.request("getControlState", scope), config))
        gate_deadline = time.monotonic() + 15
        wait = stage("ready", lambda: tab.expect_download(timeout_ms=15000, require_path=True))
        gate_deadline = min(gate_deadline, time.monotonic() + wait.remaining_ms / 1000)
        detail.update(waiterId=wait.waiter_id, remainingMs=wait.remaining_ms, readyAt=now())
        stage("gate", lambda: await_ready_gate(config["readyGate"], detail, gate_deadline))

        def click_within_wait(locator, trigger=False):
            timeout_ms = remaining_action_timeout(gate_deadline)
            if trigger:
                detail["triggerAt"] = now()
            locator.click(timeout_ms=timeout_ms)
            remaining_action_timeout(gate_deadline)

        if config["variant"] == "dynamic-oopif":
            stage("addFrame", lambda: click_within_wait(tab.get_by_role("button", name="Add download frame", exact=True)))
        target = tab if config["variant"] == "root" else tab.frame_locator("#download-frame")
        stage("trigger", lambda: click_within_wait(target.get_by_role("button", name="Download original report", exact=True), trigger=True))
        download = stage("collect", wait.result)
        detail.update(downloadId=download.download_id, collectedAt=now())
        detail["productPath"] = stage("path", lambda: download.path(timeout_ms=10000))
        detail["file"] = stage("file", lambda: read_original_file(detail["productPath"]))
        detail["page"] = stage("page", lambda: state_text(target.locator("#state").text_content(timeout_ms=5000)))
        if config["variant"] == "dynamic-oopif":
            detail["rootPage"] = stage("rootPage", lambda: state_text(tab.locator("#state").text_content(timeout_ms=5000)))
        stage("verify", lambda: check_evidence(detail, config))
    except Exception as error:
        # Preserve even an unexpected failure between stages without masking it
        # with the separate observer/client cleanup outcomes below.
        detail.setdefault("error", {"stage": "internal", "type": type(error).__name__, "message": str(error)})
    finally:
        if wait is not None:
            detail["waitCleanup"]["attempted"] = True
            try:
                stage("waitCleanup", wait.cancel)
                detail["waitCleanup"]["ok"] = True
            except Exception:
                detail["waitCleanup"]["error"] = detail["stages"][-1]["error"]
        if browser is not None:
            try:
                stage("close", browser.close)
            except Exception:
                pass
    detail["ok"] = "error" not in detail and detail["waitCleanup"]["ok"]
    return detail


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    try:
        raw = sys.stdin.buffer.read(65537)
        require(len(raw) <= 65536, "Helper input exceeds limit")
        detail = run(json.loads(raw))
    except Exception as error:
        detail = {"caller": "python", "ok": False, "stages": [], "waitCleanup": {"attempted": False, "ok": False},
                  "error": {"stage": "input", "type": type(error).__name__, "message": str(error)}}
    print(json.dumps(detail, ensure_ascii=False, allow_nan=False))
    if not detail["ok"]:
        print(json.dumps(detail["error"], ensure_ascii=False), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
