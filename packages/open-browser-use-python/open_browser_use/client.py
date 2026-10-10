from __future__ import annotations

import json
import copy
import math
import struct
import time
from dataclasses import dataclass
from typing import Any, Callable, Literal

from ._downloads import OpenBrowserUseDownload, download_id, download_params, download_timeout
from ._page_exports import ExportFormat, PDFOptions, PageExport, export_params, export_timeout, validate_export
from ._transport import Transport, connect_transport, remaining_time
from ._browser_actions import BrowserKeyboard, BrowserMouse, LocatorFactory, OpenBrowserUseLocator, action_options
from ._ai_snapshot import AISnapshot, snapshot_limits, validate_snapshot
from ._navigation_waits import NavigationLoadState, NavigationWaitUntil, OpenBrowserUseNavigationWait, navigation_ack, navigation_params, navigation_timeout
from ._network_waits import NetworkWaitEvent, NetworkWaitMatch, OpenBrowserUseNetworkWait, network_ack, network_match, network_timeout


JsonObject = dict[str, Any]
LoadState = Literal["domcontentloaded", "load"]
NotificationHandler = Callable[[JsonObject], None]
DEFAULT_NAVIGATION_TIMEOUT = 10.0
MAX_FRAME_SIZE = 64 * 1024 * 1024
CONTROL_DISCOVERY_METHODS = frozenset({"ping", "getInfo", "getControlState"})
BOUNDED_WAIT_METHODS = frozenset({"browserAction", "waitForFileChooser", "waitForDownload", "armNetworkWait", "armNavigationWait", "downloadURL", "downloadPath", "cancelDownload", "exportPage"})
NAVIGATION_WAIT_METHODS = frozenset({"armNavigationWait", "collectNavigationWait", "cancelNavigationWait"})
NETWORK_WAIT_METHODS = frozenset({"armNetworkWait", "collectNetworkWait", "cancelNetworkWait"})


@dataclass
class OpenBrowserUseClient:
    socket_path: str
    session_id: str = "open-browser-use-python"
    turn_id: str | None = None
    timeout: float = 10.0

    def __post_init__(self) -> None:
        if self.turn_id is None:
            self.turn_id = f"turn-{time.time_ns()}"
        self._next_id = 1
        self._socket: Transport | None = None
        self._notification_handlers: list[NotificationHandler] = []
        self.browser_engine: JsonObject | None = None
        self._lifecycle_version: int | None = None
        self._control_epoch: int | None = None
        self._direct_downloads_version: Any = None
        self._page_export_version: Any = None
        self._navigation_wait_version: Any = None
        self._network_wait_version: Any = None

    def connect(self) -> "OpenBrowserUseClient":
        return self._connect(self.timeout)

    def _connect(self, timeout: float) -> "OpenBrowserUseClient":
        if not math.isfinite(timeout) or timeout <= 0:
            raise ValueError("timeout must be a positive finite number")
        if self._socket is None:
            self._socket = connect_transport(self.socket_path, timeout)
        return self

    def close(self) -> None:
        if self._socket is not None:
            self._socket.close()
            self._socket = None

    def on_notification(self, handler: NotificationHandler) -> Callable[[], None]:
        self._notification_handlers.append(handler)

        def remove() -> None:
            if handler in self._notification_handlers:
                self._notification_handlers.remove(handler)

        return remove

    def request(self, method: str, params: JsonObject | None = None, *, timeout: float | None = None) -> Any:
        return self._request(method, params, timeout=timeout)

    def _request(self, method: str, params: JsonObject | None = None, *, timeout: float | None = None,
                 prepare: Callable[[JsonObject, float], None] | None = None,
                 execute: Callable[[JsonObject, float], Any] | None = None) -> Any:
        request_timeout = self.timeout if timeout is None else timeout
        if not math.isfinite(request_timeout) or request_timeout <= 0:
            raise ValueError("timeout must be a positive finite number")
        submitted_at = time.monotonic()
        deadline = submitted_at + request_timeout
        # This client is synchronous. Capture this invocation before any
        # discovery request so an end response cannot rebind older work.
        session_id, turn_id, epoch = self.session_id, self.turn_id, self._control_epoch
        merged_params: JsonObject = {"session_id": session_id, "turn_id": turn_id, **copy.deepcopy(params or {})}
        if method in BOUNDED_WAIT_METHODS:
            requested = merged_params.get("timeoutMs", 10000)
            if type(requested) in (int, float) and math.isfinite(requested) and 1 <= requested <= 120000:
                deadline = min(deadline, submitted_at + requested / 1000 + 1)
        manual_epoch = "control_epoch" in merged_params
        protected = method not in CONTROL_DISCOVERY_METHODS
        if protected and not manual_epoch:
            if merged_params["session_id"] != session_id or merged_params["turn_id"] != turn_id:
                raise ValueError("Use a separate client or explicit control_epoch for another session or turn")
            if self._lifecycle_version is None:
                info = self._wire_request("getInfo", {"session_id": session_id, "turn_id": turn_id}, deadline)
                self._observe_control_support(info)
            if self._lifecycle_version == 1:
                if epoch is None:
                    state = self._wire_request("getControlState", {"session_id": session_id, "turn_id": turn_id}, deadline)
                    epoch, _ = self._validate_control_state(state)
                    self._control_epoch = epoch
                merged_params["control_epoch"] = epoch
        if method in NETWORK_WAIT_METHODS:
            if self._network_wait_version is None:
                self._observe_control_support(self._wire_request("getInfo", {"session_id": session_id, "turn_id": turn_id}, deadline))
            if type(self._network_wait_version) is not int or self._network_wait_version != 1:
                raise RuntimeError("OBU_NETWORK_WAIT_UNSUPPORTED: extension does not advertise networkWaitVersion 1")
        if method in NAVIGATION_WAIT_METHODS:
            if self._navigation_wait_version is None:
                self._observe_control_support(self._wire_request("getInfo", {"session_id": session_id, "turn_id": turn_id}, deadline))
            if type(self._navigation_wait_version) is not int or self._navigation_wait_version != 1:
                raise RuntimeError("OBU_NAVIGATION_WAIT_UNSUPPORTED: extension does not advertise navigationWaitVersion 1")
        if method in {"downloadURL", "cancelDownload"}:
            if self._direct_downloads_version is None:
                self._observe_control_support(self._wire_request("getInfo", {"session_id": session_id, "turn_id": turn_id}, deadline))
            if type(self._direct_downloads_version) is not int or self._direct_downloads_version != 1:
                raise RuntimeError("OBU_DIRECT_DOWNLOADS_UNSUPPORTED: extension does not advertise directDownloadsVersion 1")
        if method == "exportPage":
            if self._page_export_version is None:
                self._observe_control_support(self._wire_request("getInfo", {"session_id": session_id, "turn_id": turn_id}, deadline))
            if type(self._page_export_version) is not int or self._page_export_version != 1:
                raise RuntimeError("OBU_PAGE_EXPORT_UNSUPPORTED: extension does not advertise pageExportVersion 1")
        if prepare is not None:
            prepare(merged_params, deadline)
        result = (self._wire_request(method, merged_params, deadline) if execute is None
                  else execute(merged_params, deadline))
        if method == "getInfo":
            self._observe_control_support(result)
        if (method in {"turnEnded", "finalizeTabs"} and not manual_epoch
                and self._lifecycle_version == 1 and self._control_epoch == epoch
                and self.session_id == session_id and self.turn_id == turn_id):
            next_epoch, next_turn = self._validate_control_state(result)
            if next_epoch <= epoch:
                raise RuntimeError("End response did not advance the control epoch; explicitly begin a new turn")
            self._control_epoch, self.turn_id = next_epoch, next_turn
        return result

    def _observe_control_support(self, info: Any) -> None:
        metadata = info.get("metadata", {}) if isinstance(info, dict) else {}
        self._direct_downloads_version = metadata.get("directDownloadsVersion", 0) if isinstance(metadata, dict) else 0
        self._page_export_version = metadata.get("pageExportVersion", 0) if isinstance(metadata, dict) else 0
        if self._page_export_version is None:
            self._page_export_version = 0
        self._navigation_wait_version = metadata.get("navigationWaitVersion", 0) if isinstance(metadata, dict) else 0
        self._network_wait_version = metadata.get("networkWaitVersion", 0) if isinstance(metadata, dict) else 0
        version = metadata.get("turnLifecycleVersion") if isinstance(metadata, dict) else None
        if version is not None and (type(version) is not int or version != 1):
            raise RuntimeError(f"Unsupported turn lifecycle version: {version!r}; update the SDK")
        # Never downgrade an established modern session after reconnecting.
        if self._lifecycle_version != 1:
            self._lifecycle_version = 1 if version == 1 else 0

    @staticmethod
    def _validate_control_state(state: Any) -> tuple[int, str]:
        if (not isinstance(state, dict) or type(state.get("lifecycleVersion")) is not int
                or state.get("lifecycleVersion") != 1):
            raise RuntimeError("Invalid turn lifecycle response")
        epoch, turn_id = state.get("controlEpoch"), state.get("nextTurnId")
        if (type(epoch) is not int or epoch < 1 or epoch > 9007199254740991
                or not isinstance(turn_id, str) or not turn_id):
            raise RuntimeError("Invalid control epoch or next turn ID")
        if "closing" in state and type(state["closing"]) is not bool:
            raise RuntimeError("Invalid closing state in turn lifecycle response")
        if state.get("closing"):
            raise RuntimeError("Previous turn is still closing; explicitly begin a turn after cleanup")
        return epoch, turn_id

    def begin_turn(self) -> Any:
        """Explicitly recover current control state; never replay an old action."""
        state = self.request("getControlState")
        epoch, turn_id = self._validate_control_state(state)
        self._lifecycle_version, self._control_epoch, self.turn_id = 1, epoch, turn_id
        return state

    def _wire_request(self, method: str, merged_params: JsonObject, deadline: float, *, response_reserve: float = 0) -> Any:
        self._connect(remaining_time(deadline))
        if self._socket is None:
            raise RuntimeError("Open Browser Use socket is not connected")
        if response_reserve and deadline - time.monotonic() <= response_reserve:
            raise TimeoutError(f"{method} deadline expired during discovery or connection; request was not sent")
        request_id = self._next_id
        self._next_id += 1
        if method in BOUNDED_WAIT_METHODS:
            requested = merged_params.get("timeoutMs", 10000)
            if method == "exportPage":
                export_timeout(requested)
            if method in {"downloadURL", "downloadPath", "cancelDownload"}:
                if requested is None:
                    raise ValueError("Download timeoutMs must be an integer from 1 to 120000")
                download_timeout(requested)
            if method in {"armNetworkWait", "armNavigationWait"}:
                if requested is None:
                    raise ValueError(f"{method} timeoutMs must be an integer from 1 to 120000")
                (navigation_timeout if method == "armNavigationWait" else network_timeout)(requested)
            if type(requested) in (int, float) and math.isfinite(requested) and 1 <= requested <= 120000:
                available_ms = math.floor((deadline - time.monotonic() - 1) * 1000)
                if available_ms < 1:
                    raise TimeoutError(f"{method} deadline expired during discovery or connection; request was not sent")
                merged_params = {**merged_params, "timeoutMs": min(requested, available_ms)}
        request = {
            "jsonrpc": "2.0",
            "id": request_id,
            "method": method,
            "params": merged_params,
        }
        try:
            self._socket.settimeout(remaining_time(deadline))
            self._socket.sendall(encode_frame(request))
            while True:
                response = read_frame(self._socket, deadline=deadline)
                if response.get("id") == request_id:
                    break
                if "id" not in response and isinstance(response.get("method"), str):
                    self._dispatch_notification(response)
                    continue
                raise RuntimeError(f"unexpected response id: {response.get('id')!r}")
        except BaseException:
            # A partial frame or late response must not poison the next request.
            # Do not replay: the timed-out operation may already have run.
            self.close()
            raise
        if "error" in response:
            message = response["error"].get("message", "Open Browser Use request failed")
            raise RuntimeError(message)
        return response.get("result")

    def _download(self, tab_id: int, method: str, params: JsonObject) -> OpenBrowserUseDownload:
        timeout = params["timeoutMs"]
        def start(metadata: JsonObject, deadline: float) -> OpenBrowserUseDownload:
            if type(metadata.get("control_epoch")) is not int or metadata["control_epoch"] < 1:
                raise RuntimeError("Download handles require an explicit control epoch")
            binding = {key: metadata[key] for key in ("session_id", "turn_id", "control_epoch")}
            identifier = download_id(self._wire_request(method, metadata, deadline))
            captured = {**binding, "downloadId": identifier}
            return OpenBrowserUseDownload(identifier, lambda operation, budget:
                self.request(operation, {**captured, "timeoutMs": budget}, timeout=budget / 1000 + 1))
        return self._request(method, {**params, "tabId": tab_id}, timeout=timeout / 1000 + 1, execute=start)

    def _expect_network(self, tab_id: int, event: NetworkWaitEvent, match: NetworkWaitMatch,
                        timeout_ms: int | None = None) -> OpenBrowserUseNetworkWait:
        timeout = network_timeout(timeout_ms)
        frozen = network_match(event, match)

        def arm(metadata: JsonObject, deadline: float) -> OpenBrowserUseNetworkWait:
            if type(metadata.get("control_epoch")) is not int or metadata["control_epoch"] < 1:
                raise RuntimeError("Network waits require an explicit control epoch")
            binding = {key: metadata[key] for key in ("session_id", "turn_id", "control_epoch")}
            ack = self._wire_request("armNetworkWait", metadata, deadline)
            waiter_id, remaining = network_ack(ack, timeout)
            params = {**binding, "tabId": tab_id, "waiterId": waiter_id}
            return OpenBrowserUseNetworkWait(waiter_id, remaining, event,
                lambda method, read_timeout: self.request(method, params, timeout=read_timeout))

        return self._request("armNetworkWait", {"tabId": tab_id, "event": event, "match": frozen, "timeoutMs": timeout},
                             timeout=timeout / 1000 + 1, execute=arm)

    def _expect_navigation(self, tab_id: int, params: JsonObject) -> OpenBrowserUseNavigationWait:
        timeout = params["timeoutMs"]
        def arm(metadata: JsonObject, deadline: float) -> OpenBrowserUseNavigationWait:
            if type(metadata.get("control_epoch")) is not int or metadata["control_epoch"] < 1:
                raise RuntimeError("Navigation waits require an explicit control epoch")
            binding = {key: metadata[key] for key in ("session_id", "turn_id", "control_epoch")}
            ack = self._wire_request("armNavigationWait", metadata, deadline)
            waiter_id, remaining = navigation_ack(ack, timeout)
            captured = {**binding, "tabId": tab_id, "waiterId": waiter_id}
            return OpenBrowserUseNavigationWait(waiter_id, remaining,
                lambda method, read_timeout: self.request(method, captured, timeout=read_timeout))
        return self._request("armNavigationWait", {**params, "tabId": tab_id}, timeout=timeout / 1000 + 1, execute=arm)

    def _dispatch_notification(self, notification: JsonObject) -> None:
        for handler in list(self._notification_handlers):
            handler(notification)

    def browser_action(
        self, tab_id: int, action: str, *, locator: list[JsonObject] | None = None,
        args: JsonObject | None = None, timeout_ms: int | None = None,
    ) -> Any:
        params: JsonObject = {"tabId": tab_id, "action": action}
        if locator is not None:
            params["locator"] = locator
        if args is not None:
            params["args"] = args
        effective_timeout = 10000 if timeout_ms is None else timeout_ms
        if not math.isfinite(effective_timeout) or effective_timeout < 1 or effective_timeout > 120000:
            raise ValueError("timeout_ms must be between 1 and 120000")
        params["timeoutMs"] = effective_timeout
        response = self.request("browserAction", params, timeout=effective_timeout / 1000 + 1)
        if (not isinstance(response, dict) or "value" not in response
                or not isinstance(response.get("engine"), dict)
                or not all(isinstance(response["engine"].get(key), str)
                           for key in ("name", "version", "playwrightVersion"))):
            raise RuntimeError("browserAction response did not include a value; update the native host and extension")
        self.browser_engine = response["engine"]
        return response

    def get_info(self) -> Any:
        return self.request("getInfo")

    def create_tab(self) -> Any:
        return self.request("createTab")

    def get_tabs(self) -> Any:
        return self.request("getTabs")

    def get_user_tabs(self) -> Any:
        return self.request("getUserTabs")

    def get_user_history(self, **params: Any) -> Any:
        return self.request("getUserHistory", params)

    def claim_user_tab(self, tab_id: int) -> Any:
        return self.request("claimUserTab", {"tabId": tab_id})

    def finalize_tabs(self, keep: list[JsonObject]) -> Any:
        return self.request("finalizeTabs", {"keep": keep})

    def name_session(self, name: str) -> Any:
        return self.request("nameSession", {"name": name})

    def attach(self, tab_id: int) -> Any:
        return self.request("attach", {"tabId": tab_id})

    def detach(self, tab_id: int) -> Any:
        return self.request("detach", {"tabId": tab_id})

    def execute_cdp(self, tab_id: int, method: str, command_params: JsonObject | None = None) -> Any:
        return self.request(
            "executeCdp",
            {
                "target": {"tabId": tab_id},
                "method": method,
                "commandParams": command_params or {},
            },
        )

    def move_mouse(self, tab_id: int, x: float, y: float, wait_for_arrival: bool = True) -> Any:
        return self.request(
            "moveMouse",
            {
                "tabId": tab_id,
                "x": x,
                "y": y,
                "waitForArrival": wait_for_arrival,
            },
        )

    def wait_for_file_chooser(self, tab_id: int, timeout_ms: int | None = None) -> Any:
        return self._wait_for_tab_event("waitForFileChooser", tab_id, timeout_ms)

    def _wait_for_tab_event(self, method: str, tab_id: int, timeout_ms: int | None) -> Any:
        effective_timeout = 10000 if timeout_ms is None else timeout_ms
        if type(effective_timeout) is not int or not 1 <= effective_timeout <= 120000:
            raise ValueError("timeout_ms must be an integer between 1 and 120000")
        return self.request(method, {"tabId": tab_id, "timeoutMs": effective_timeout},
                            timeout=effective_timeout / 1000 + 1)

    def set_file_chooser_files(self, file_chooser_id: str, files: list[str]) -> Any:
        return self.request(
            "setFileChooserFiles",
            {
                "fileChooserId": file_chooser_id,
                "files": files,
            },
        )

    def wait_for_download(self, tab_id: int, timeout_ms: int | None = None) -> Any:
        return self._wait_for_tab_event("waitForDownload", tab_id, timeout_ms)

    def download_path(self, download_id: str, timeout_ms: int | None = None) -> Any:
        timeout = download_timeout(timeout_ms)
        return self.request("downloadPath", {"downloadId": download_id, "timeoutMs": timeout}, timeout=timeout / 1000 + 1)

    def browser_user_history(self, **params: Any) -> Any:
        return self.get_user_history(**params)

    def read_clipboard_text(self, tab_id: int) -> Any:
        return self.request("readClipboardText", {"tabId": tab_id})

    def write_clipboard_text(self, tab_id: int, text: str) -> Any:
        return self.request("writeClipboardText", {"tabId": tab_id, "text": text})

    def read_clipboard(self, tab_id: int) -> Any:
        return self.request("readClipboard", {"tabId": tab_id})

    def write_clipboard(self, tab_id: int, items: list[JsonObject]) -> Any:
        return self.request("writeClipboard", {"tabId": tab_id, "items": items})

    def turn_ended(self) -> Any:
        return self.request("turnEnded")


def connect_open_browser_use(
    socket_path: str,
    session_id: str = "open-browser-use-python",
    turn_id: str | None = None,
    timeout: float = 10.0,
) -> "OpenBrowserUseBrowser":
    browser = OpenBrowserUseBrowser(
        OpenBrowserUseClient(
            socket_path=socket_path,
            session_id=session_id,
            turn_id=turn_id,
            timeout=timeout,
        )
    )
    browser.connect()
    return browser


class OpenBrowserUseBrowser:
    def __init__(self, client: OpenBrowserUseClient) -> None:
        self.client = client
        self.cdp = OpenBrowserUseCdp(client)

    def connect(self) -> "OpenBrowserUseBrowser":
        self.client.connect()
        return self

    def close(self) -> None:
        self.client.close()

    def new_tab(
        self,
        url: str | None = None,
        wait_until: LoadState = "load",
        timeout: float = DEFAULT_NAVIGATION_TIMEOUT,
    ) -> "OpenBrowserUseTab":
        if url and (not math.isfinite(timeout) or not 0.001 <= timeout <= 120):
            raise ValueError("navigation timeout must be between 0.001 and 120 seconds")

        def create_and_navigate(metadata: JsonObject, deadline: float) -> Any:
            created = self.client._wire_request("createTab", metadata, deadline, response_reserve=1 if url else 0)
            if url:
                tab_id = _tab_id_from_value(created, "create_tab response")
                response = self.client._wire_request("browserAction", {
                    **metadata, "tabId": tab_id, "action": "goto",
                    "args": {"url": url, "waitUntil": wait_until}, "timeoutMs": int(timeout * 1000),
                }, deadline)
                if not isinstance(response, dict) or "value" not in response or not isinstance(response.get("engine"), dict):
                    raise RuntimeError("Invalid browserAction response while navigating the new tab")
                self.client.browser_engine = response["engine"]
            return created

        result = self.client._request("createTab", timeout=timeout + 1 if url else None,
                                      execute=create_and_navigate)
        tab = self.tab(_tab_id_from_value(result, "create_tab response"))
        return tab

    def tab(self, tab_id: int) -> "OpenBrowserUseTab":
        return OpenBrowserUseTab(self, tab_id)

    def get_tabs(self) -> Any:
        return self.client.get_tabs()


class OpenBrowserUseTab(LocatorFactory):
    def download_url(self, url: str, *, filename: str | None = None, timeout_ms: int | None = None) -> OpenBrowserUseDownload:
        return self.browser.client._download(self.id, "downloadURL", download_params(url, filename, timeout_ms))

    def export_page(self, format: ExportFormat, *, max_bytes: int | None = None,
                    timeout_ms: int | None = None, pdf: PDFOptions | None = None) -> PageExport:
        params = export_params(format, max_bytes, timeout_ms, pdf)
        value = self.browser.client.request("exportPage", {**params, "tabId": self.id}, timeout=params["timeoutMs"] / 1000 + 1)
        return validate_export(value, format, params["maxBytes"])

    def export_pdf(self, *, max_bytes: int | None = None, timeout_ms: int | None = None,
                   pdf: PDFOptions | None = None) -> PageExport:
        return self.export_page("pdf", max_bytes=max_bytes, timeout_ms=timeout_ms, pdf=pdf)

    def export_mhtml(self, *, max_bytes: int | None = None, timeout_ms: int | None = None) -> PageExport:
        return self.export_page("mhtml", max_bytes=max_bytes, timeout_ms=timeout_ms)

    def wait_for_download(self, *, timeout_ms: int | None = None) -> OpenBrowserUseDownload:
        return self.browser.client._download(self.id, "waitForDownload", {"timeoutMs": download_timeout(timeout_ms)})

    def expect_request(self, match: NetworkWaitMatch, *, timeout_ms: int | None = None) -> OpenBrowserUseNetworkWait:
        return self.browser.client._expect_network(self.id, "request", match, timeout_ms)

    def expect_response(self, match: NetworkWaitMatch, *, timeout_ms: int | None = None) -> OpenBrowserUseNetworkWait:
        return self.browser.client._expect_network(self.id, "response", match, timeout_ms)

    def __init__(self, browser: OpenBrowserUseBrowser, tab_id: int) -> None:
        self.browser = browser
        self.id = tab_id
        super().__init__(self)
        self.playwright = OpenBrowserUseTabPlaywright(self)
        self.mouse = BrowserMouse(self)
        self.keyboard = BrowserKeyboard(self)

    def action(self, action: str, *, locator: list[JsonObject] | None = None,
               args: JsonObject | None = None, timeout_ms: int | None = None) -> Any:
        return self.browser.client.browser_action(
            self.id, action, locator=locator, args=args, timeout_ms=timeout_ms,
        )["value"]

    def goto(
        self,
        url: str,
        wait_until: LoadState = "load",
        timeout: float = DEFAULT_NAVIGATION_TIMEOUT,
    ) -> Any:
        return self.action("goto", args={"url": url, "waitUntil": wait_until}, timeout_ms=int(timeout * 1000))

    def wait_for_load_state(
        self,
        state: LoadState = "load",
        timeout: float = DEFAULT_NAVIGATION_TIMEOUT,
    ) -> None:
        self.action("waitForLoadState", args={"state": state}, timeout_ms=int(timeout * 1000))

    def go_back(self, *, wait_until: LoadState = "load", timeout: float = DEFAULT_NAVIGATION_TIMEOUT) -> Any:
        return self.action("goBack", args={"waitUntil": wait_until}, timeout_ms=int(timeout * 1000))

    def go_forward(self, *, wait_until: LoadState = "load", timeout: float = DEFAULT_NAVIGATION_TIMEOUT) -> Any:
        return self.action("goForward", args={"waitUntil": wait_until}, timeout_ms=int(timeout * 1000))

    def reload(self, *, wait_until: LoadState = "load", timeout: float = DEFAULT_NAVIGATION_TIMEOUT) -> Any:
        return self.action("reload", args={"waitUntil": wait_until}, timeout_ms=int(timeout * 1000))

    def dom_snapshot(self) -> str:
        return self.action("snapshot")

    def snapshot_ai(self, *, max_bytes: int | None = None, max_nodes: int | None = None,
                    max_refs: int | None = None, max_frames: int | None = None,
                    max_depth: int | None = None, timeout_ms: int | None = None) -> AISnapshot:
        args, limits = snapshot_limits({"maxBytes": max_bytes, "maxNodes": max_nodes,
                                       "maxRefs": max_refs, "maxFrames": max_frames, "maxDepth": max_depth})
        return validate_snapshot(self.action("snapshotAI", args=args, timeout_ms=timeout_ms), limits)

    def expect_url(self, url: str, *, wait_until: NavigationWaitUntil = "load", timeout_ms: int | None = None) -> OpenBrowserUseNavigationWait:
        return self.browser.client._expect_navigation(self.id, navigation_params("url", url, wait_until, timeout_ms))

    def expect_load_state(self, *, state: NavigationLoadState = "load", timeout_ms: int | None = None) -> OpenBrowserUseNavigationWait:
        return self.browser.client._expect_navigation(self.id, navigation_params("loadstate", None, state, timeout_ms))

    def wait_for_url(self, url: str, *, timeout_ms: int | None = None,
                     wait_until: LoadState = "load") -> None:
        self.action("waitForURL", args={"url": url, "waitUntil": wait_until}, timeout_ms=timeout_ms)

    def screenshot(self, *, timeout_ms: int | None = None, **options: Any) -> JsonObject:
        return self.action("screenshot", args=action_options(options), timeout_ms=timeout_ms)

    def diagnostics(self, *, after: JsonObject | None = None, limit: int | None = None,
                    timeout_ms: int | None = None) -> JsonObject:
        """Read bounded console/error/network history since this engine attachment."""
        args: JsonObject = {}
        if after is not None:
            args["after"] = after
        if limit is not None:
            args["limit"] = limit
        return self.action("diagnostics", args=args, timeout_ms=timeout_ms)

    def evaluate(self, expression: str, await_promise: bool | None = None) -> Any:
        return self.browser.cdp.evaluate(self.id, expression, await_promise=await_promise)

    def title(self) -> str:
        value = self.evaluate("document.title ?? ''")
        return "" if value is None else str(value)

    def url(self) -> str:
        value = self.evaluate("location.href")
        return "" if value is None else str(value)

    def wait_for_timeout(self, timeout_ms: float) -> None:
        if timeout_ms < 0:
            raise ValueError("timeout_ms must be non-negative")
        time.sleep(timeout_ms / 1000)

    def locator(self, selector: str) -> "OpenBrowserUseLocator":
        return OpenBrowserUseLocator(self, selector)

    def close(self) -> Any:
        return self.browser.cdp.call(self.id, "Page.close")


class OpenBrowserUseTabPlaywright(LocatorFactory):
    def expect_request(self, match: NetworkWaitMatch, *, timeout_ms: int | None = None) -> OpenBrowserUseNetworkWait:
        return self.tab.expect_request(match, timeout_ms=timeout_ms)

    def expect_response(self, match: NetworkWaitMatch, *, timeout_ms: int | None = None) -> OpenBrowserUseNetworkWait:
        return self.tab.expect_response(match, timeout_ms=timeout_ms)

    def __init__(self, tab: OpenBrowserUseTab) -> None:
        super().__init__(tab)
        self.tab = tab

    @property
    def engine_info(self) -> JsonObject | None:
        return self.tab.browser.client.browser_engine

    def snapshot_ai(self, *, max_bytes: int | None = None, max_nodes: int | None = None,
                    max_refs: int | None = None, max_frames: int | None = None,
                    max_depth: int | None = None, timeout_ms: int | None = None) -> AISnapshot:
        return self.tab.snapshot_ai(max_bytes=max_bytes, max_nodes=max_nodes, max_refs=max_refs,
                                    max_frames=max_frames, max_depth=max_depth, timeout_ms=timeout_ms)

    def screenshot(self, *, timeout_ms: int | None = None, **options: Any) -> JsonObject:
        return self.tab.screenshot(timeout_ms=timeout_ms, **options)

    def expect_url(self, url: str, *, wait_until: NavigationWaitUntil = "load", timeout_ms: int | None = None) -> OpenBrowserUseNavigationWait:
        return self.tab.expect_url(url, wait_until=wait_until, timeout_ms=timeout_ms)

    def expect_load_state(self, *, state: NavigationLoadState = "load", timeout_ms: int | None = None) -> OpenBrowserUseNavigationWait:
        return self.tab.expect_load_state(state=state, timeout_ms=timeout_ms)

    def wait_for_url(self, url: str, *, timeout_ms: int | None = None,
                     wait_until: LoadState = "load") -> None:
        self.tab.wait_for_url(url, timeout_ms=timeout_ms, wait_until=wait_until)

    def wait_for_load_state(
        self,
        state: LoadState = "load",
        timeout: float = DEFAULT_NAVIGATION_TIMEOUT,
    ) -> None:
        self.tab.wait_for_load_state(state=state, timeout=timeout)

    def dom_snapshot(self) -> str:
        return self.tab.dom_snapshot()

    def title(self) -> str:
        return self.tab.title()

    def url(self) -> str:
        return self.tab.url()

    def wait_for_timeout(self, timeout_ms: float) -> None:
        self.tab.wait_for_timeout(timeout_ms)

    def locator(self, selector: str) -> "OpenBrowserUseLocator":
        return self.tab.locator(selector)


class OpenBrowserUseCdp:
    def __init__(self, client: OpenBrowserUseClient) -> None:
        self.client = client

    def call(
        self,
        tab_id: int,
        method: str,
        command_params: JsonObject | None = None,
        timeout_ms: int | None = None,
    ) -> Any:
        params: JsonObject = {
            "target": {"tabId": tab_id},
            "method": method,
            "commandParams": command_params or {},
        }
        if timeout_ms is not None:
            params["timeoutMs"] = timeout_ms

        def attach(metadata: JsonObject, deadline: float) -> None:
            binding = {key: metadata[key] for key in ("session_id", "turn_id", "control_epoch") if key in metadata}
            self.client._wire_request("attach", {**binding, "tabId": tab_id}, deadline)
            if (self.client.session_id != binding["session_id"] or self.client.turn_id != binding["turn_id"]
                    or self.client._control_epoch != binding.get("control_epoch")):
                raise RuntimeError("CDP command belonged to a previous turn; command was not sent")

        return self.client._request("executeCdp", params, prepare=attach)

    def evaluate(self, tab_id: int, expression: str, await_promise: bool | None = None) -> Any:
        command_params: JsonObject = {
            "expression": expression,
            "returnByValue": True,
        }
        if await_promise is not None:
            command_params["awaitPromise"] = await_promise
        result = self.call(tab_id, "Runtime.evaluate", command_params)
        if isinstance(result, dict) and isinstance(result.get("exceptionDetails"), dict):
            raise RuntimeError(str(result["exceptionDetails"].get("text", "Open Browser Use evaluation failed")))
        if isinstance(result, dict) and isinstance(result.get("result"), dict):
            return result["result"].get("value")
        return None

    def navigate(
        self,
        tab_id: int,
        url: str,
        wait_until: LoadState = "load",
        timeout: float = DEFAULT_NAVIGATION_TIMEOUT,
    ) -> Any:
        if not url:
            raise ValueError("goto requires a URL")
        _assert_supported_load_state(wait_until)

        def navigate_scoped(metadata: JsonObject, deadline: float) -> Any:
            self.client._wire_request("attach", {**metadata, "tabId": tab_id}, deadline)
            self._call_scoped(tab_id, "Page.enable", {}, metadata, deadline)
            result = self._call_scoped(tab_id, "Page.navigate", {"url": url}, metadata, deadline)
            if isinstance(result, dict) and result.get("errorText"):
                raise RuntimeError(f"Browser failed to navigate tab {tab_id}: {result['errorText']}")
            loader_id = result.get("loaderId", "") if isinstance(result, dict) else ""
            self._wait_for_load_state_scoped(tab_id, wait_until, loader_id, metadata, deadline)
            return result

        return self.client._request("executeCdp", timeout=timeout, execute=navigate_scoped)

    def wait_for_load_state(
        self,
        tab_id: int,
        state: LoadState = "load",
        timeout: float = DEFAULT_NAVIGATION_TIMEOUT,
    ) -> None:
        _assert_supported_load_state(state)

        def wait_scoped(metadata: JsonObject, deadline: float) -> None:
            self.client._wire_request("attach", {**metadata, "tabId": tab_id}, deadline)
            self._wait_for_load_state_scoped(tab_id, state, "", metadata, deadline)

        self.client._request("executeCdp", timeout=timeout, execute=wait_scoped)

    def _call_scoped(self, tab_id: int, method: str, command_params: JsonObject,
                     metadata: JsonObject, deadline: float) -> Any:
        return self.client._wire_request("executeCdp", {
            **metadata, "target": {"tabId": tab_id}, "method": method, "commandParams": command_params,
        }, deadline)

    def _wait_for_load_state_scoped(self, tab_id: int, state: LoadState, loader_id: str,
                                    metadata: JsonObject, deadline: float) -> None:
        def same_loader() -> bool:
            if not loader_id:
                return True
            tree = self._call_scoped(tab_id, "Page.getFrameTree", {}, metadata, deadline)
            return isinstance(tree, dict) and tree.get("frameTree", {}).get("frame", {}).get("loaderId") == loader_id

        while True:
            if same_loader():
                result = self._call_scoped(tab_id, "Runtime.evaluate", {
                    "expression": "({ href: window.location.href, readyState: document.readyState })",
                    "returnByValue": True,
                }, metadata, deadline)
                document_state = result.get("result", {}).get("value") if isinstance(result, dict) else None
                if _document_state_matches(document_state, state) and same_loader():
                    return
            time.sleep(min(0.1, remaining_time(deadline)))

    def read_document_state(self, tab_id: int) -> JsonObject | None:
        try:
            value = self.evaluate(tab_id, "({ href: window.location.href, readyState: document.readyState })")
        except Exception:
            return None
        return value if isinstance(value, dict) else None

    def ensure_attached(self, tab_id: int) -> None:
        # Timeouts, turn end and the browser may detach independently of this
        # client. Attach is idempotent; never replay the following CDP command.
        self.client.attach(tab_id)


def encode_frame(value: JsonObject) -> bytes:
    payload = json.dumps(value, separators=(",", ":")).encode("utf-8")
    if len(payload) > MAX_FRAME_SIZE:
        raise ValueError("Open Browser Use frame exceeds 64 MiB")
    return struct.pack(_native_u32(), len(payload)) + payload


def read_frame(sock: Transport, *, deadline: float | None = None) -> JsonObject:
    header = _read_exact(sock, 4, deadline=deadline)
    (length,) = struct.unpack(_native_u32(), header)
    if length > MAX_FRAME_SIZE:
        raise ValueError("Open Browser Use frame exceeds 64 MiB")
    payload = _read_exact(sock, length, deadline=deadline)
    value = json.loads(payload.decode("utf-8"))
    if not isinstance(value, dict):
        raise RuntimeError("Open Browser Use response must be a JSON object")
    return value


def _read_exact(sock: Transport, length: int, *, deadline: float | None = None) -> bytes:
    chunks: list[bytes] = []
    remaining = length
    while remaining > 0:
        if deadline is not None:
            sock.settimeout(remaining_time(deadline))
        chunk = sock.recv(remaining)
        if not chunk:
            raise EOFError("Open Browser Use socket closed")
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def _native_u32() -> str:
    return "=I"


def _tab_id_from_value(value: Any, label: str) -> int:
    if not isinstance(value, dict):
        raise RuntimeError(f"{label} did not include a tab object")
    tab_id = value.get("id")
    if isinstance(tab_id, int) and tab_id > 0:
        return tab_id
    if isinstance(tab_id, str) and tab_id.isdigit() and int(tab_id) > 0:
        return int(tab_id)
    raise RuntimeError(f"{label} did not include a numeric tab id")


def _assert_supported_load_state(state: str) -> None:
    if state not in ("domcontentloaded", "load"):
        raise ValueError(f'Unsupported load state "{state}". Use "domcontentloaded" or "load".')


def _document_state_matches(document_state: JsonObject | None, state: LoadState) -> bool:
    ready_state = document_state.get("readyState") if isinstance(document_state, dict) else None
    return ready_state == "complete" or (state == "domcontentloaded" and ready_state == "interactive")
