"""Connection identity checked against real local byte streams, not browser mocks.

The replacement peer deliberately accepts the original numeric epoch, session,
turn and handles. Rejection must happen in the SDK before it receives a request.
"""

import contextlib
import json
import os
import struct
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from open_browser_use import OpenBrowserUseBrowser, OpenBrowserUseClient
from open_browser_use.client import encode_frame
from open_browser_use._transport import connect_transport
from test_transport_support import local_server


DISCONNECTED = "OBU_SDK_BROWSER_DISCONNECTED"
INFO = {"metadata": {"turnLifecycleVersion": 1, "downloadWaitVersion": 1,
                     "directDownloadsVersion": 1, "navigationWaitVersion": 1,
                     "networkWaitVersion": 1, "fileChooserWaitVersion": 1}}
STATE = {"lifecycleVersion": 1, "controlEpoch": 1, "nextTurnId": "original-turn"}
ENGINE = {"name": "playwright-crx", "version": "0.15.0", "playwrightVersion": "1.53.0"}


def receive(conn, records):
    def exact(length):
        chunks = []
        while length:
            chunk = conn.recv(length)
            if not chunk:
                raise EOFError()
            chunks.append(chunk)
            length -= len(chunk)
        return b"".join(chunks)

    header = exact(4)
    payload = exact(struct.unpack("=I", header)[0])
    message = json.loads(payload)
    records.append({"direction": "request", "frameHex": (header + payload).hex(), "message": message})
    return message


def reply(conn, request, records, *, result=None):
    method = request["method"]
    if result is None:
        if method == "getInfo":
            result = INFO
        elif method == "getControlState":
            result = STATE
        elif method == "createTab":
            result = {"id": 7}
        elif method == "browserAction":
            result = {"value": "accepted", "engine": ENGINE}
        elif method.startswith("arm"):
            result = {"waiterId": method, "remainingMs": request["params"]["timeoutMs"]}
        elif method in ("downloadURL", "collectDownloadWait"):
            result = {"downloadId": "original-download"}
        elif method == "downloadPath":
            result = {"path": "replacement-accepted"}
        elif method == "cancelDownload":
            result = {"cancelled": True}
        elif method == "collectFileChooserWait":
            result = {"tabId": 7, "multiple": False, "backendNodeId": 10}
        else:
            result = {}
    message = {"id": request["id"], "result": result}
    frame = encode_frame(message)
    records.append({"direction": "response", "frameHex": frame.hex(), "message": message})
    conn.sendall(frame)


@contextlib.contextmanager
def endpoint(directory, callback, *, path=None):
    path, listener = local_server(directory, path=path)
    errors, records = [], []

    def run():
        try:
            conn, _ = listener.accept()
            with conn:
                callback(conn, records)
        except BaseException as error:
            errors.append(error)
        finally:
            listener.close()

    thread = threading.Thread(target=run, daemon=True)
    thread.start()
    try:
        yield path, records
    finally:
        thread.join(6)
        if thread.is_alive():
            raise AssertionError("Connection identity peer did not finish")
        if os.name != "nt":
            Path(path).unlink()
        if errors:
            raise errors[0]


def accepting_peer(conn, records):
    while True:
        try:
            request = receive(conn, records)
        except EOFError:
            return
        reply(conn, request, records)


def requests(records):
    return [item["message"] for item in records if item["direction"] == "request"]


class ConnectionIdentityTest(unittest.TestCase):
    def replacement_case(self, failure):
        def first_peer(conn, records):
            while True:
                try:
                    request = receive(conn, records)
                except EOFError:
                    return
                if request["method"] == "breakConnection":
                    if failure == "timeout":
                        conn.sendall(b"\x20\x00")
                        time.sleep(0.2)
                    elif failure == "unexpected-id":
                        reply(conn, {**request, "id": request["id"] + 1}, records)
                    return
                reply(conn, request, records)

        with tempfile.TemporaryDirectory() as directory:
            with endpoint(directory, first_peer) as (path, original):
                client = OpenBrowserUseClient(path, session_id="original-session", turn_id="original-turn", timeout=2)
                browser = OpenBrowserUseBrowser(client)
                tab = browser.new_tab()
                locator = tab.locator("#original")
                wait = tab.expect_download(timeout_ms=10000)
                navigation = tab.expect_load_state(timeout_ms=10000)
                network = tab.expect_request({"url": "https://example.test/"}, timeout_ms=10000)
                chooser = tab.expect_file_chooser(timeout_ms=10000)
                download = tab.download_url("https://example.test/file")
                if failure == "close":
                    client.close()
                else:
                    error = {"eof": EOFError, "timeout": TimeoutError, "unexpected-id": RuntimeError}[failure]
                    with self.assertRaises(error) as raised:
                        client.request("breakConnection", {"control_epoch": 1}, timeout=0.05)
                    self.assertNotIn(DISCONNECTED, str(raised.exception), "the first wire failure keeps its original error")

            with endpoint(directory, accepting_peer, path=path) as (_, replacement):
                operations = [
                    ("connect", client.connect), ("browser-connect", browser.connect),
                    ("discovery", client.get_info), ("begin-turn", client.begin_turn),
                    ("client", client.get_tabs), ("tab", lambda: tab.action("url")),
                    ("locator", locator.click), ("wait", wait.result), ("wait-cancel", wait.cancel),
                    ("navigation", navigation.result), ("network-cancel", network.cancel),
                    ("chooser-cancel", chooser.cancel), ("download-path", download.path),
                    ("download-cancel", download.cancel),
                    ("manual-epoch", lambda: client.request("browserAction", {
                        "session_id": "original-session", "turn_id": "original-turn", "control_epoch": 1,
                        "tabId": 7, "action": "click", "timeoutMs": 1000})),
                ]
                for label, operation in operations:
                    with self.subTest(failure=failure, operation=label), self.assertRaisesRegex(RuntimeError, DISCONNECTED):
                        operation()
                # If old code did reconnect, close that actual stream. Otherwise
                # a new, explicitly identified client proves B really is live.
                reconnected = client._socket is not None
                client.close()
                if not reconnected:
                    probe = OpenBrowserUseClient(path, session_id="replacement-probe", timeout=2)
                    try:
                        probe.get_info()
                    finally:
                        probe.close()

            with endpoint(directory, accepting_peer, path=path) as (_, recovery):
                fresh = OpenBrowserUseClient(path, session_id="original-session", turn_id="original-turn", timeout=2)
                try:
                    OpenBrowserUseBrowser(fresh).tab(7).locator("#original").click()
                finally:
                    fresh.close()

            evidence = {"failure": failure, "platform": os.name, "original": original,
                        "replacement": replacement, "recovery": recovery}
            output = os.environ.get("OBU_CONNECTION_EVIDENCE_DIR")
            if output:
                with (Path(output) / f"python-{failure}.json").open("x", encoding="utf-8") as stream:
                    json.dump(evidence, stream, ensure_ascii=False, indent=2)
            stale = [item for item in requests(replacement) if item["params"]["session_id"] == "original-session"]
            self.assertEqual(stale, [], "replacement peer must receive zero requests from the disconnected client")
            self.assertEqual([item["method"] for item in requests(recovery)], ["getInfo", "getControlState", "browserAction"])
            self.assertEqual(client._control_epoch, 1, "disconnect must not reset the epoch to impersonate fresh authority")
            self.assertEqual(client.turn_id, "original-turn")
            self.assertEqual(sum(item["method"] == "breakConnection" for item in requests(original)), failure != "close")

    def test_eof_does_not_migrate_old_handles(self):
        self.replacement_case("eof")

    def test_explicit_close_does_not_migrate_old_handles(self):
        self.replacement_case("close")

    def test_timeout_does_not_replay_or_migrate(self):
        self.replacement_case("timeout")

    def test_bad_wire_response_does_not_migrate(self):
        self.replacement_case("unexpected-id")

    def test_first_connect_failure_can_retry(self):
        for implicit in (False, True):
            with self.subTest(implicit=implicit), tempfile.TemporaryDirectory() as directory:
                path, listener = local_server(directory)
                listener.close()
                if os.name != "nt":
                    Path(path).unlink()
                client = OpenBrowserUseClient(path, timeout=0.1)
                with self.assertRaises(OSError):
                    (client.get_info if implicit else client.connect)()
                with endpoint(directory, accepting_peer, path=path) as (_, records):
                    try:
                        self.assertEqual(client.get_info(), INFO)
                    finally:
                        client.close()
                self.assertEqual([item["method"] for item in requests(records)], ["getInfo"])

    def test_wire_error_survives_native_close_failure(self):
        def fail(conn, records):
            receive(conn, records)

        with tempfile.TemporaryDirectory() as directory:
            with endpoint(directory, fail) as (path, records):
                client = OpenBrowserUseClient(path).connect()
                connection = client._socket

                class FailingClose:
                    def __getattr__(self, name):
                        return getattr(connection, name)

                    def close(self):
                        connection.close()
                        raise OSError("native close failed")

                client._socket = FailingClose()
                with self.assertRaises(EOFError):
                    client.get_info()
                with self.assertRaisesRegex(RuntimeError, DISCONNECTED):
                    client.get_info()
                self.assertIsNone(client._socket)
            self.assertEqual(len(requests(records)), 1)

    def test_changing_path_keeps_the_original_live_connection(self):
        def identified_peer(name):
            def serve(conn, records):
                while True:
                    try:
                        request = receive(conn, records)
                    except EOFError:
                        return
                    reply(conn, request, records, result={"peer": name, **INFO})
            return serve

        with tempfile.TemporaryDirectory() as first, tempfile.TemporaryDirectory() as second:
            with endpoint(first, identified_peer("A")) as (path_a, records_a):
                with endpoint(second, identified_peer("B")) as (path_b, records_b):
                    client = OpenBrowserUseClient(path_a, session_id="original")
                    self.assertEqual(client.get_info()["peer"], "A")
                    client.socket_path = path_b
                    self.assertEqual(client.get_info()["peer"], "A")
                    client.close()
                    with self.assertRaisesRegex(RuntimeError, DISCONNECTED):
                        client.get_info()
                    fresh = OpenBrowserUseClient(path_b, session_id="fresh")
                    try:
                        self.assertEqual(fresh.get_info()["peer"], "B")
                    finally:
                        fresh.close()
            self.assertEqual([item["params"]["session_id"] for item in requests(records_a)], ["original", "original"])
            self.assertEqual([item["params"]["session_id"] for item in requests(records_b)], ["fresh"])

    def test_local_unsent_failures_keep_the_original_connection(self):
        with tempfile.TemporaryDirectory() as directory:
            with endpoint(directory, accepting_peer) as (path, records):
                client = OpenBrowserUseClient(path)
                try:
                    self.assertEqual(client.get_info(), INFO)
                    original = client._socket
                    with self.assertRaises(TypeError):
                        client.request("getInfo", {"value": {1, 2}})
                    with self.assertRaisesRegex(TimeoutError, "deadline expired"):
                        client._wire_request("getInfo", {}, time.monotonic() + 1, start_before=time.monotonic() - 1)
                    # Expiry after frame encoding is also a local unsent error.
                    def expired_encode(value):
                        result = encode_frame(value)
                        time.sleep(0.03)
                        return result

                    with patch("open_browser_use.client.encode_frame", expired_encode):
                        with self.assertRaises(TimeoutError):
                            client.request("getInfo", timeout=0.01)
                    self.assertIs(client._socket, original)
                    self.assertEqual(client.get_info(), INFO)
                finally:
                    client.close()
            self.assertEqual([item["method"] for item in requests(records)], ["getInfo", "getInfo"])

    def test_close_during_connection_factory_cannot_revive_client(self):
        # The client remains synchronous; a reentrant connection factory proves
        # that explicit close wins even if a native connection returns later.
        with tempfile.TemporaryDirectory() as directory:
            with endpoint(directory, accepting_peer) as (path, records):
                client = OpenBrowserUseClient(path)

                def close_before_return(endpoint_path, timeout):
                    connection = connect_transport(endpoint_path, timeout)
                    client.close()
                    return connection

                with patch("open_browser_use.client.connect_transport", close_before_return):
                    with self.assertRaisesRegex(RuntimeError, DISCONNECTED):
                        client.get_info()
                self.assertIsNone(client._socket)
                with self.assertRaisesRegex(RuntimeError, DISCONNECTED):
                    client.connect()
            self.assertEqual(requests(records), [])

    def test_native_settimeout_failure_is_terminal(self):
        with tempfile.TemporaryDirectory() as directory:
            with endpoint(directory, accepting_peer) as (path, records):
                client = OpenBrowserUseClient(path).connect()
                connection = client._socket

                class FailingTimeout:
                    def __getattr__(self, name):
                        return getattr(connection, name)

                    def settimeout(self, timeout):
                        raise OSError("native timeout configuration failed")

                client._socket = FailingTimeout()
                with self.assertRaisesRegex(OSError, "native timeout configuration failed"):
                    client.get_info()
                with self.assertRaisesRegex(RuntimeError, DISCONNECTED):
                    client.get_info()
                self.assertIsNone(client._socket)
            self.assertEqual(requests(records), [])

    def test_close_before_first_connect_is_terminal(self):
        client = OpenBrowserUseClient("unused")
        client.close()
        client.close()
        for operation in (client.connect, client.begin_turn, client.get_info):
            with self.subTest(operation=operation.__name__), self.assertRaisesRegex(RuntimeError, DISCONNECTED):
                operation()


if __name__ == "__main__":
    unittest.main()
