import tempfile
import threading
import time
import unittest

from open_browser_use.client import OpenBrowserUseClient, OpenBrowserUseCdp, OpenBrowserUseBrowser, encode_frame, read_frame
from test_transport_support import local_server


class ControlLifecycleTest(unittest.TestCase):
    def test_malformed_schema_does_not_treat_boolean_as_protocol_version(self):
        client = OpenBrowserUseClient("unused")
        with self.assertRaises(RuntimeError):
            client._observe_control_support({"metadata": {"turnLifecycleVersion": True}})
        for values in ({"lifecycleVersion": True}, {"closing": "false"}, {"controlEpoch": True}):
            with self.subTest(values=values), self.assertRaises(RuntimeError):
                client._validate_control_state({"lifecycleVersion": 1, "controlEpoch": 1, "nextTurnId": "next", **values})

    def serve(self, exchanges, exercise):
        errors = []
        with tempfile.TemporaryDirectory() as directory:
            endpoint, listener = local_server(directory)

            def server():
                try:
                    conn, _ = listener.accept()
                    with conn:
                        for method, check, result in exchanges:
                            message = read_frame(conn)
                            self.assertEqual(message["method"], method)
                            check(message["params"])
                            conn.sendall(encode_frame({"id": message["id"], **result}))
                except BaseException as error:
                    errors.append(error)
                finally:
                    listener.close()

            thread = threading.Thread(target=server, daemon=True)
            thread.start()
            client = OpenBrowserUseClient(endpoint, turn_id="initial", timeout=1)
            try:
                exercise(client)
            finally:
                client.close()
            thread.join(timeout=2)
            self.assertFalse(thread.is_alive(), "mock transport did not finish")
            if errors:
                raise errors[0]

    def state(self, epoch, turn="next", **extra):
        return {"result": {"lifecycleVersion": 1, "controlEpoch": epoch, "nextTurnId": turn, **extra}}

    def test_end_advances_only_after_success_and_stale_error_never_replays(self):
        no_check = lambda params: None
        old = lambda params: self.assertEqual((params["turn_id"], params["control_epoch"]), ("initial", 7))
        new = lambda params: self.assertEqual((params["turn_id"], params["control_epoch"]), ("next", 8))
        recovered = lambda params: self.assertEqual((params["turn_id"], params["control_epoch"]), ("recovered", 20))

        def exercise(client):
            client.create_tab()
            client.turn_ended()
            self.assertEqual(client.turn_id, "next")
            with self.assertRaisesRegex(RuntimeError, "Stale control epoch"):
                client.create_tab()
            self.assertEqual(client._control_epoch, 8)
            client.begin_turn()
            client.create_tab()

        self.serve([
            ("getInfo", no_check, {"result": {"metadata": {"turnLifecycleVersion": 1}}}),
            ("getControlState", no_check, self.state(7)),
            ("createTab", old, {"result": {"id": 42}}),
            ("turnEnded", old, self.state(8)),
            ("createTab", new, {"error": {"message": "Stale control epoch"}}),
            ("getControlState", no_check, self.state(20, "recovered")),
            ("createTab", recovered, {"result": {"id": 43}}),
        ], exercise)

    def test_closing_state_prevents_input(self):
        def exercise(client):
            with self.assertRaisesRegex(RuntimeError, "still closing"):
                client.create_tab()
            self.assertIsNone(client._control_epoch)

        self.serve([
            ("getInfo", lambda p: None, {"result": {"metadata": {"turnLifecycleVersion": 1}}}),
            ("getControlState", lambda p: None, self.state(7, closing=True)),
        ], exercise)

    def test_legacy_host_negotiates_once_and_does_not_receive_epoch(self):
        def no_epoch(params):
            self.assertNotIn("control_epoch", params)

        self.serve([
            ("getInfo", no_epoch, {"result": {"metadata": {}}}),
            ("createTab", no_epoch, {"result": {"id": 1}}),
            ("turnEnded", no_epoch, {"result": {}}),
        ], lambda client: (client.create_tab(), client.turn_ended()))

    def test_invalid_end_response_cannot_rebind_client(self):
        def exercise(client):
            client.create_tab()
            with self.assertRaisesRegex(RuntimeError, "did not advance"):
                client.finalize_tabs([])
            self.assertEqual(client._control_epoch, 7)
            self.assertEqual(client.turn_id, "initial")

        self.serve([
            ("getInfo", lambda p: None, {"result": {"metadata": {"turnLifecycleVersion": 1}}}),
            ("getControlState", lambda p: None, self.state(7)),
            ("createTab", lambda p: None, {"result": {"id": 1}}),
            ("finalizeTabs", lambda p: None, self.state(7)),
        ], exercise)

    def test_discovery_consumes_action_budget_before_engine_receives_it(self):
        def delay(_):
            time.sleep(0.08)

        def check(params):
            self.assertGreater(params["timeoutMs"], 0)
            self.assertLessEqual(params["timeoutMs"], 430)

        def exercise(client):
            client.timeout = 10
            client.browser_action(7, "click", locator=[{"kind": "css", "selector": "button"}], timeout_ms=500)

        self.serve([
            ("getInfo", delay, {"result": {"metadata": {}}}),
            ("browserAction", check, {"result": {"value": None, "engine": {
                "name": "playwright-crx", "version": "0.15.0", "playwrightVersion": "1.53.0"}}}),
        ], exercise)

    def test_discovery_cannot_retarget_caller_locator_arguments(self):
        step = {"kind": "css", "selector": "#observed"}

        def mutate(_):
            step["selector"] = "#unexpected"

        self.serve([
            ("getInfo", mutate, {"result": {"metadata": {}}}),
            ("browserAction", lambda p: self.assertEqual(p["locator"][0]["selector"], "#observed"),
             {"result": {"value": None, "engine": {"name": "playwright-crx", "version": "0.15.0", "playwrightVersion": "1.53.0"}}}),
        ], lambda client: client.browser_action(7, "click", locator=[step]))

    def test_event_wait_discovery_uses_original_budget_and_allows_reply_grace(self):
        for method in ("waitForFileChooser", "waitForDownload"):
            with self.subTest(method=method):
                def delay(_):
                    time.sleep(0.08)

                def check(params):
                    self.assertGreater(params["timeoutMs"], 0)
                    self.assertLessEqual(params["timeoutMs"], 430)

                def exercise(client):
                    client.timeout = 10
                    helper = client.wait_for_file_chooser if method == "waitForFileChooser" else client.wait_for_download
                    self.assertEqual(helper(7, 500), {"id": "owned-event"})

                self.serve([
                    ("getInfo", delay, {"result": {"metadata": {}}}),
                    (method, check, {"result": {"id": "owned-event"}}),
                ], exercise)

    def test_event_wait_invalid_timeout_fails_before_connecting(self):
        client = OpenBrowserUseClient("unused")
        for helper in (client.wait_for_file_chooser, client.wait_for_download):
            for timeout in (0, -1, True, 0.5, float("inf"), 120001):
                with self.subTest(helper=helper.__name__, timeout=timeout), self.assertRaises(ValueError):
                    helper(7, timeout)

    def test_raw_navigation_captures_epoch_and_waits_for_new_loader(self):
        def binding(params):
            self.assertEqual((params["turn_id"], params["control_epoch"]), ("initial", 7))

        def command(method):
            def check(params):
                binding(params)
                self.assertEqual(params["method"], method)
            return check

        self.serve([
            ("getInfo", lambda p: None, {"result": {"metadata": {"turnLifecycleVersion": 1}}}),
            ("getControlState", lambda p: None, self.state(7)),
            ("attach", binding, {"result": {}}),
            ("executeCdp", command("Page.enable"), {"result": {}}),
            ("executeCdp", command("Page.navigate"), {"result": {"frameId": "main", "loaderId": "new"}}),
            ("executeCdp", command("Page.getFrameTree"), {"result": {"frameTree": {"frame": {"loaderId": "old"}}}}),
            ("executeCdp", command("Page.getFrameTree"), {"result": {"frameTree": {"frame": {"loaderId": "new"}}}}),
            ("executeCdp", command("Runtime.evaluate"), {"result": {"result": {"value": {"readyState": "complete"}}}}),
            ("executeCdp", command("Page.getFrameTree"), {"result": {"frameTree": {"frame": {"loaderId": "new"}}}}),
        ], lambda client: OpenBrowserUseCdp(client).navigate(7, "https://example.test"))

    def test_short_operation_expires_during_discovery_with_default_client_budget(self):
        for method in ("browserAction", "waitForFileChooser", "waitForDownload", "newTab"):
            with self.subTest(method=method):
                def exercise(client):
                    client.timeout = 10
                    with self.assertRaisesRegex(TimeoutError, "request was not sent"):
                        if method == "newTab":
                            OpenBrowserUseBrowser(client).new_tab("https://example.test", timeout=0.1)
                        else:
                            client.request(method, {"tabId": 7, "action": "click", "timeoutMs": 100})

                self.serve([
                    ("getInfo", lambda _: time.sleep(0.25), {"result": {"metadata": {}}}),
                ], exercise)
