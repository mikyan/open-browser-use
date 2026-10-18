"""Bounded sequential public typed Python SDK adapter; no browser fallback."""
import json
import sys

MAX_LINE = 65536
MAX_RESPONSE = 512 * 1024
FIELDS = {
    "connect": {"socketPath", "sessionId", "timeoutMs"}, "create": set(),
    "goto": {"tabId", "url", "timeoutMs"}, "expectPage": {"tabId", "timeoutMs"},
    "click": {"tabId", "name", "timeoutMs"}, "collectPage": set(), "cancelPage": set(),
    "snapshot": {"tabId"}, "text": {"tabId", "selector", "timeoutMs"},
    "fill": {"tabId", "selector", "value", "timeoutMs"}, "waitVisible": {"tabId", "selector", "timeoutMs"},
    "expectDownload": {"tabId", "timeoutMs"}, "collectDownload": set(),
    "downloadPath": {"timeoutMs"}, "cancelDownload": set(), "tabs": set(),
    "finalize": {"keep"}, "close": set(),
}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "Duplicate JSON field")
        result[key] = value
    return result


def browser_factory(args):
    from open_browser_use import OpenBrowserUseBrowser, OpenBrowserUseClient
    return OpenBrowserUseBrowser(OpenBrowserUseClient(args["socketPath"], session_id=args["sessionId"], timeout=args["timeoutMs"] / 1000))


class TypedHelper:
    def __init__(self, factory=browser_factory):
        self.factory = factory
        self.browser = self.page_wait = self.download_wait = self.download = None
        self.tabs = {}
        self.sequence = 0
        self.failed = False
        self.closed = False
        self.created = False
        self.finalized = False

    def call(self, message):
        identifier = message.get("id") if isinstance(message, dict) else None
        try:
            require(not self.closed, "Original helper is closed")
            require(isinstance(message, dict) and set(message) == {"id", "op", "args"}, "Invalid helper envelope")
            require(type(identifier) is int and identifier == self.sequence + 1 and identifier <= 48, "Sequential bounded request ID required")
            self.sequence = identifier
            op, args = message["op"], message["args"]
            require(isinstance(op, str) and op in FIELDS, "Unknown typed helper operation")
            require(isinstance(args, dict) and set(args) == FIELDS[op], "Invalid operation fields")
            require(not self.failed or op in {"cancelPage", "cancelDownload", "close"}, "Original helper failed; only cleanup remains")
            if "timeoutMs" in args:
                require(type(args["timeoutMs"]) is int and 1 <= args["timeoutMs"] <= 20000, "Invalid timeout")
            if "tabId" in args:
                require(type(args["tabId"]) is int and args["tabId"] in self.tabs, "Original typed tab required")
            for field in ("socketPath", "sessionId", "url", "name", "selector", "value"):
                if field in args:
                    require(isinstance(args[field], str) and 0 < len(args[field].encode("utf-8")) <= 4096 and "\0" not in args[field], "Invalid string argument")
            result = self.execute(op, args)
            return {"id": identifier, "ok": True, "result": result}
        except Exception as error:
            self.failed = True
            return {"id": identifier, "ok": False, "error": {"type": type(error).__name__, "message": str(error)}}

    def execute(self, op, args):
        if op == "close":
            try:
                if self.browser is not None:
                    self.browser.close()
            finally:
                self.closed = True
            return None
        if op == "connect":
            require(self.browser is None, "Only one original connection is allowed")
            self.browser = self.factory(args)
            self.browser.connect()
            return self.browser.client.begin_turn()
        require(self.browser is not None, "Connect the original browser first")
        tab = self.tabs.get(args.get("tabId"))
        timeout = args.get("timeoutMs")
        if op == "create":
            require(not self.created, "Only one original source is allowed")
            self.created = True
            tab = self.browser.new_tab(background_window=True)
            self.tabs[tab.id] = tab
            return {"tabId": tab.id}
        if op == "goto":
            return tab.goto(args["url"], wait_until="load", timeout=timeout / 1000)
        if op == "expectPage":
            require(self.page_wait is None, "Only one original page wait is allowed")
            self.page_wait = tab.expect_page(timeout_ms=timeout)
            return {"waiterId": self.page_wait.waiter_id, "remainingMs": self.page_wait.remaining_ms}
        if op == "click":
            return tab.get_by_role("button", name=args["name"], exact=True).click(timeout_ms=timeout)
        if op == "collectPage":
            require(self.page_wait is not None, "Original page wait required")
            child = self.page_wait.result()
            self.tabs[child.id] = child  # Keep its original scope-bound client.
            return {"tabId": child.id}
        if op == "cancelPage":
            require(self.page_wait is not None, "Original page wait required")
            return self.page_wait.cancel()
        if op == "snapshot":
            return tab.dom_snapshot()
        if op == "text":
            return tab.locator(args["selector"]).text_content(timeout_ms=timeout)
        if op == "fill":
            return tab.locator(args["selector"]).fill(args["value"], timeout_ms=timeout)
        if op == "waitVisible":
            return tab.locator(args["selector"]).wait_for(state="visible", timeout_ms=timeout)
        if op == "expectDownload":
            require(self.download_wait is None, "Only one original download wait is allowed")
            self.download_wait = tab.expect_download(timeout_ms=timeout, require_path=True)
            return {"waiterId": self.download_wait.waiter_id, "remainingMs": self.download_wait.remaining_ms}
        if op == "collectDownload":
            require(self.download_wait is not None, "Original download wait required")
            self.download = self.download_wait.result()
            return {"downloadId": self.download.download_id}
        if op == "downloadPath":
            require(self.download is not None, "Original download required")
            return self.download.path(timeout_ms=timeout)
        if op == "cancelDownload":
            require(self.download_wait is not None, "Original download wait required")
            return self.download_wait.cancel()
        if op == "tabs":
            return self.browser.get_tabs()
        if op == "finalize":
            require(not self.finalized, "Finalize is never replayed")
            keep = args["keep"]
            require(isinstance(keep, list) and len(keep) == 1 and isinstance(keep[0], dict)
                    and set(keep[0]) == {"tabId", "status"} and type(keep[0]["tabId"]) is int
                    and keep[0]["tabId"] in self.tabs and keep[0]["status"] == "deliverable", "Invalid original deliverable")
            self.finalized = True
            return self.browser.client.finalize_tabs(keep)
        raise ValueError("Unimplemented typed operation")


def serve(source, destination, helper=None):
    helper = helper or TypedHelper()
    try:
        while not helper.closed:
            line = source.readline(MAX_LINE + 1)
            if not line:
                break
            try:
                require(len(line) <= MAX_LINE and line.endswith(b"\n"), "Bounded complete JSONL request required")
                request = json.loads(line.decode("utf-8"), object_pairs_hook=unique_object,
                                     parse_constant=lambda value: (_ for _ in ()).throw(ValueError("Non-finite JSON")))
                response = helper.call(request)
            except Exception as error:
                helper.failed = True
                response = {"id": None, "ok": False, "error": {"type": type(error).__name__, "message": str(error)}}
            encoded = json.dumps(response, ensure_ascii=False, allow_nan=False).encode("utf-8") + b"\n"
            require(len(encoded) <= MAX_RESPONSE, "Typed helper response bound exceeded")
            destination.write(encoded)
            destination.flush()
            if len(line) > MAX_LINE or not line.endswith(b"\n"):
                break
    except Exception:
        helper.failed = True
        raise
    finally:
        if not helper.closed:
            try:
                if helper.browser is not None:
                    helper.browser.close()
            except Exception as error:
                helper.failed = True
                failure = {"id": 0, "ok": False, "error": {"type": type(error).__name__, "message": str(error)}}
                destination.write(json.dumps(failure, ensure_ascii=False).encode("utf-8") + b"\n")
                destination.flush()
            helper.closed = True
    return 1 if helper.failed else 0


if __name__ == "__main__":
    try:
        sys.exit(serve(sys.stdin.buffer, sys.stdout.buffer))
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
