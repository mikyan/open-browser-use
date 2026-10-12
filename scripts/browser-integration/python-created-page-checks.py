"""One native created page through the public typed Python SDK; no replay."""
import json
import os
from pathlib import Path
import stat
import sys
import time
import uuid

from open_browser_use import OpenBrowserUseBrowser, OpenBrowserUseClient


MAX_FILE_BYTES = 65536
FIELDS = {"socketPath", "sessionId", "turnId", "controlEpoch", "tabId", "variant", "key", "owner", "readyGate"}


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
    raise TimeoutError("Ready gate deadline expired; no created-page input submitted")


def remaining_action_timeout(deadline):
    milliseconds = int((deadline - time.monotonic()) * 1000) - 1000
    if milliseconds < 1:
        raise TimeoutError("Created page deadline expired; no further input submitted")
    return min(5000, milliseconds)


def require(condition, message):
    if not condition:
        raise ValueError(message)


def validate_input(value):
    require(isinstance(value, dict) and set(value) == FIELDS, "Invalid helper input fields")
    for name in ("socketPath", "sessionId", "turnId", "key", "owner"):
        require(isinstance(value[name], str) and 0 < len(value[name]) <= 4096, f"Invalid {name}")
    require(type(value["controlEpoch"]) is int and 1 <= value["controlEpoch"] <= 9007199254740991, "Invalid controlEpoch")
    require(type(value["tabId"]) is int and 0 <= value["tabId"] <= 9007199254740991, "Invalid tabId")
    require(value["variant"] in ("root", "oopif", "dynamic-oopif"), "Invalid variant")
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


def check_source(page, config, clicked=False):
    require(all(page.get(key) == config[key] for key in ("key", "owner", "variant")), "Wrong original source document")
    for key in ("sourceNonce", "documentToken"):
        require(isinstance(page.get(key), str) and str(uuid.UUID(page[key])) == page[key], "Invalid original source identity")
    clicks = page.get("clicks")
    require(isinstance(clicks, list) and len(clicks) == int(clicked), "Original link must be clicked exactly once")
    if clicked:
        click = clicks[0]
        require(isinstance(click, dict) and click.get("trusted") is True and click.get("ctrlKey") is True
                and all(click.get(key) is False for key in ("metaKey", "altKey", "shiftKey"))
                and type(click.get("button")) is int and click["button"] == 0
                and type(click.get("sequence")) is int and click["sequence"] == 1,
                "Missing sole trusted Control click")
        require(all(click.get(key) == page[key] for key in ("sourceNonce", "documentToken")), "Original source changed")
    return page


def check_child(page, before=None):
    for key in ("documentNonce", "documentToken"):
        require(isinstance(page.get(key), str) and str(uuid.UUID(page[key])) == page[key], "Invalid original child identity")
    if before is None:
        require(page.get("clicks") == [], "Child was already used")
    else:
        require(all(page[key] == before[key] for key in ("documentNonce", "documentToken")), "Child identity changed")
        clicks = page.get("clicks")
        require(isinstance(clicks, list) and len(clicks) == 1 and isinstance(clicks[0], dict)
                and clicks[0].get("trusted") is True and type(clicks[0].get("sequence")) is int
                and clicks == [{"trusted": True, "sequence": 1, "documentNonce": page["documentNonce"], "documentToken": page["documentToken"]}], "Child POST requires one trusted click")
    return page


def run(config):
    detail = {"caller": "python", "stages": [], "waitCleanup": {"attempted": False, "ok": False},
              "clientClose": {"attempted": False, "ok": False}, "ok": False}
    browser = wait = None
    now = lambda: time.time_ns() // 1000000
    deadline = None

    def budget():
        require(deadline is not None and time.monotonic() < deadline, "Original created-page deadline expired")
        return deadline - time.monotonic()

    def stage(name, operation, cleanup=False):
        record = {"name": name, "startedAt": now(), "ok": False}; detail["stages"].append(record)
        try:
            if not cleanup and deadline is not None: budget()
            result = operation()
            if not cleanup and deadline is not None: budget()
            record["ok"] = True
            return result
        except Exception as error:
            failure = {"stage": name, "type": type(error).__name__, "message": str(error)}
            record["error"] = failure; detail.setdefault("error", failure)
            raise
        finally:
            record["finishedAt"] = now()

    def action(operation):
        timeout = remaining_action_timeout(deadline)
        value = operation(timeout)
        budget()
        return value

    def read_state(target):
        raw = action(lambda timeout: target.locator("#state").text_content(timeout_ms=timeout))
        require(isinstance(raw, str) and len(raw.encode("utf-8")) <= 65536, "Invalid or oversized document state")
        return state_text(raw)

    try:
        stage("input", lambda: validate_input(config))
        scope = {"session_id": config["sessionId"], "turn_id": config["turnId"], "control_epoch": config["controlEpoch"]}
        detail.update(scope=scope, **{key: config[key] for key in ("tabId", "variant", "key", "owner")})
        browser = OpenBrowserUseBrowser(OpenBrowserUseClient(config["socketPath"], session_id=config["sessionId"], turn_id=config["turnId"], timeout=20))
        deadline = time.monotonic() + 20
        detail["firstRequestAt"] = now()
        stage("connect", browser.connect)
        tab = browser.tab(config["tabId"])
        def scope_state():
            return check_scope(browser.client.request("getControlState", scope, timeout=budget()), config)
        detail["scopeBefore"] = stage("scopeBefore", scope_state)
        detail["rootBefore"] = stage("rootBefore", lambda: check_source(read_state(tab), config))
        require(detail["rootBefore"].get("frameAdds") == [], "Dynamic fixture was already used")
        wait = stage("ready", lambda: tab.expect_page(timeout_ms=int(budget() * 1000)))
        deadline = min(deadline, time.monotonic() + wait.remaining_ms / 1000)
        detail.update(waiterId=wait.waiter_id, remainingMs=wait.remaining_ms, readyAt=now())
        stage("gate", lambda: await_ready_gate(config["readyGate"], detail, deadline))
        if config["variant"] == "dynamic-oopif":
            stage("addFrame", lambda: action(lambda timeout: tab.locator("#add-frame").click(timeout_ms=timeout)))
        target = tab if config["variant"] == "root" else tab.frame_locator("#created-page-frame")
        detail["sourceBefore"] = stage("sourceBefore", lambda: check_source(read_state(target), config))
        detail["triggerAt"] = now()
        stage("trigger", lambda: action(lambda timeout: target.locator("#open-child").click(timeout_ms=timeout, modifiers=["Control"])))
        child = stage("collect", wait.result)
        detail.update(childId=child.id, collectedAt=now())
        detail["sourceAfter"] = stage("sourceAfter", lambda: check_source(read_state(target), config, clicked=True))
        require(all(detail["sourceBefore"][key] == detail["sourceAfter"][key] for key in ("sourceNonce", "documentToken")), "Source changed during trigger")
        if config["variant"] == "dynamic-oopif":
            detail["rootAfter"] = stage("rootAfter", lambda: check_source(read_state(tab), config))
            adds = detail["rootAfter"].get("frameAdds")
            require(isinstance(adds, list) and len(adds) == 1 and isinstance(adds[0], dict)
                    and adds[0].get("trusted") is True and type(adds[0].get("sequence")) is int
                    and adds == [{"trusted": True, "sequence": 1}], "Dynamic frame was not added exactly once")
        detail["childBefore"] = stage("childBefore", lambda: check_child(read_state(child)))
        stage("fillKey", lambda: action(lambda timeout: child.get_by_label("Source key", exact=True).fill(config["key"], timeout_ms=timeout)))
        stage("fillOwner", lambda: action(lambda timeout: child.get_by_label("Owner", exact=True).fill(config["owner"], timeout_ms=timeout)))
        stage("commit", lambda: action(lambda timeout: child.locator("#commit").click(timeout_ms=timeout)))
        def receipt():
            while True:
                text = action(lambda timeout: child.locator("#result").text_content(timeout_ms=timeout))
                if text:
                    require(len(text.encode("utf-8")) <= 65536, "Receipt exceeds bound")
                    value = json.loads(text)
                    require(isinstance(value, dict) and value.get("ok") is True
                            and value == {"ok": True, "key": config["key"], "owner": config["owner"], "documentNonce": detail["childBefore"]["documentNonce"]}, "Wrong original child receipt")
                    return value
                time.sleep(min(.025, budget()))
        detail["receipt"] = stage("receipt", receipt)
        detail["childAfter"] = stage("childAfter", lambda: check_child(read_state(child), detail["childBefore"]))
    except Exception as error:
        detail.setdefault("error", {"stage": "internal", "type": type(error).__name__, "message": str(error)})
    finally:
        if wait is not None:
            detail["waitCleanup"]["attempted"] = True
            try:
                stage("waitCleanup", wait.cancel, cleanup=True); detail["waitCleanup"]["ok"] = True
            except Exception:
                detail["waitCleanup"]["error"] = detail["stages"][-1]["error"]
        if browser is not None:
            detail["clientClose"]["attempted"] = True
            try:
                stage("close", browser.close, cleanup=True); detail["clientClose"].update(ok=True, returnedAt=now())
            except Exception:
                detail["clientClose"]["error"] = detail["stages"][-1]["error"]
    detail["ok"] = "error" not in detail and detail["waitCleanup"]["ok"] and detail["clientClose"]["ok"]
    return detail


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    try:
        raw = sys.stdin.buffer.read(65537)
        require(len(raw) <= 65536, "Helper input exceeds limit")
        detail = run(json.loads(raw))
    except Exception as error:
        detail = {"caller": "python", "ok": False, "stages": [], "error": {"stage": "input", "type": type(error).__name__, "message": str(error)}}
    print(json.dumps(detail, ensure_ascii=False, allow_nan=False))
    if not detail["ok"]:
        print(json.dumps(detail["error"], ensure_ascii=False), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
