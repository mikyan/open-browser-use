import threading
import time
import unittest
from unittest.mock import patch

import test_lifecycle as lifecycle
from open_browser_use import OpenBrowserUseBrowser, OpenBrowserUseClient
from open_browser_use._file_chooser_waits import file_chooser_ack, file_chooser_result, file_chooser_params


INFO = {"result": {"metadata": {"turnLifecycleVersion": 1, "fileChooserWaitVersion": 1}}}
CHOOSER = {"fileChooserId": "chooser-1", "isMultiple": False}
NOOP = lambda p: None


class FileChooserWaitTest(unittest.TestCase):
    serve = lifecycle.ControlLifecycleTest.serve
    state = lifecycle.ControlLifecycleTest.state

    def test_file_setter_preserves_default_wire_and_explicit_reply_grace(self):
        def check(file_id, timeout_ms=None, delay=0):
            def inspect(params):
                self.assertEqual(params["fileChooserId"], file_id)
                self.assertEqual(params["files"], [])
                self.assertEqual((params["turn_id"], params["control_epoch"]), ("initial", 7))
                if timeout_ms is None:
                    self.assertNotIn("timeoutMs", params)
                else:
                    self.assertEqual(params["timeoutMs"], timeout_ms)
                time.sleep(delay)
            return inspect

        def exercise(client):
            with patch.object(client, "request", wraps=client.request) as request:
                self.assertEqual(client.set_file_chooser_files("default", []), {})
                client.timeout = 0.1
                self.assertEqual(client.set_file_chooser_files("slow", [], 50), {})
                self.assertEqual(client.set_file_chooser_files("maximum", [], 120000), {})
                with self.assertRaisesRegex(RuntimeError, "OBU_FILE_CHOOSER_CONSUMED"):
                    client.set_file_chooser_files("rejected", [], 1)
                self.assertEqual([call.kwargs for call in request.call_args_list], [{}, {"timeout": 1.05}, {"timeout": 121.0}, {"timeout": 1.001}])

        self.serve([
            ("getInfo", NOOP, INFO), ("getControlState", NOOP, self.state(7)),
            ("setFileChooserFiles", check("default"), {"result": {}}),
            ("setFileChooserFiles", check("slow", 50, 0.15), {"result": {}}),
            ("setFileChooserFiles", check("maximum", 120000), {"result": {}}),
            ("setFileChooserFiles", check("rejected", 1), {"error": {"message": "OBU_FILE_CHOOSER_CONSUMED"}}),
        ], exercise)

    def test_file_setter_invalid_timeout_never_requests(self):
        client = OpenBrowserUseClient("unused")
        with patch.object(client, "request", side_effect=AssertionError("invalid timeout reached request")) as request:
            for value in (True, "1", 0, -1, 1.5, float("nan"), float("inf"), 120001):
                with self.subTest(timeout=value), self.assertRaisesRegex(ValueError, "timeout_ms must be an integer"):
                    client.set_file_chooser_files("chooser", [], value)
            request.assert_not_called()

    def test_ready_trigger_collect_cancel_and_ended_scope(self):
        def old(p):
            self.assertEqual((p["turn_id"], p["control_epoch"]), ("initial", 7))

        def handle(p):
            old(p)
            self.assertEqual((p["tabId"], p["waiterId"]), (9, "w"))
            self.assertNotIn("timeoutMs", p)

        def exercise(client):
            wait = OpenBrowserUseBrowser(client).tab(9).playwright.expect_file_chooser(timeout_ms=1000)
            self.assertEqual((wait.waiter_id, wait.remaining_ms), ("w", 500))
            OpenBrowserUseBrowser(client).tab(9).get_by_role("button", name="Upload").click()
            self.assertEqual(wait.result(), CHOOSER)
            wait.cancel()
            client.begin_turn()
            with self.assertRaisesRegex(RuntimeError, "OBU_STALE_CONTROL_EPOCH"):
                wait.result()
            with self.assertRaisesRegex(RuntimeError, "OBU_STALE_CONTROL_EPOCH"):
                wait.cancel()
            self.assertEqual(client._control_epoch, 8)

        self.serve([
            ("getInfo", NOOP, INFO), ("getControlState", NOOP, self.state(7)),
            ("armFileChooserWait", old, {"result": {"waiterId": "w", "remainingMs": 500}}),
            ("browserAction", old, {"result": {"value": None, "engine": {"name": "playwright-crx", "version": "0.15.0", "playwrightVersion": "1.53.0"}}}),
            ("collectFileChooserWait", handle, {"result": CHOOSER}), ("cancelFileChooserWait", handle, {"result": {}}),
            ("getControlState", NOOP, self.state(8)),
            ("collectFileChooserWait", handle, {"error": {"message": "OBU_STALE_CONTROL_EPOCH"}}),
            ("cancelFileChooserWait", handle, {"error": {"message": "OBU_STALE_CONTROL_EPOCH"}}),
        ], exercise)

    def test_expired_result_does_not_send_and_cancellation_can_retry(self):
        def check(p):
            self.assertEqual((p["turn_id"], p["control_epoch"], p["tabId"], p["waiterId"]), ("initial", 7, 9, "w"))
            self.assertNotIn("timeoutMs", p)

        def exercise(client):
            wait = OpenBrowserUseBrowser(client).tab(9).expect_file_chooser(timeout_ms=1000)
            time.sleep(0.03)
            with self.assertRaisesRegex(TimeoutError, "deadline expired"):
                wait.result()
            wait.cancel()
            wait.cancel()

        self.serve([
            ("getInfo", NOOP, INFO), ("getControlState", NOOP, self.state(7)),
            ("armFileChooserWait", NOOP, {"result": {"waiterId": "w", "remainingMs": 20}}),
            ("cancelFileChooserWait", check, {"result": {}}), ("cancelFileChooserWait", check, {"result": {}}),
        ], exercise)

    def test_concurrent_result_is_rejected_before_a_second_collect(self):
        entered, release = threading.Event(), threading.Event()

        def collect(p):
            entered.set()
            self.assertTrue(release.wait(1))

        def exercise(client):
            wait = OpenBrowserUseBrowser(client).tab(9).expect_file_chooser()
            values, errors = [], []

            def read():
                try:
                    values.append(wait.result())
                except BaseException as error:
                    errors.append(error)

            thread = threading.Thread(target=read)
            thread.start()
            self.assertTrue(entered.wait(1))
            try:
                with self.assertRaisesRegex(RuntimeError, "OBU_FILE_CHOOSER_WAIT_CONFLICT"):
                    wait.result()
            finally:
                release.set()
                thread.join(1)
            self.assertFalse(thread.is_alive())
            self.assertEqual(errors, [])
            self.assertEqual(values, [CHOOSER])

        self.serve([
            ("getInfo", NOOP, INFO), ("getControlState", NOOP, self.state(7)),
            ("armFileChooserWait", NOOP, {"result": {"waiterId": "w", "remainingMs": 1000}}),
            ("collectFileChooserWait", collect, {"result": CHOOSER}),
        ], exercise)

    def test_slow_bootstrap_and_reconnect_cannot_use_response_reserve_to_send_late(self):
        for raw in (False, True):
            def exercise(client):
                with self.assertRaisesRegex(TimeoutError, "deadline"):
                    if raw:
                        client.request("armFileChooserWait", {"tabId": 9, "timeoutMs": 30})
                    else:
                        OpenBrowserUseBrowser(client).tab(9).expect_file_chooser(timeout_ms=30)

            self.serve([
                ("getInfo", lambda p: time.sleep(0.08), INFO), ("getControlState", NOOP, self.state(7)),
            ], exercise)

        def reconnect(client):
            wait = OpenBrowserUseBrowser(client).tab(9).expect_file_chooser()
            connect = client._connect

            def slow(timeout):
                time.sleep(0.06)
                return connect(timeout)

            client._connect = slow
            # No transport read/write may occur after the original wait deadline.
            with self.assertRaisesRegex(TimeoutError, "deadline expired"):
                wait.result()

        self.serve([
            ("getInfo", NOOP, INFO), ("getControlState", NOOP, self.state(7)),
            ("armFileChooserWait", NOOP, {"result": {"waiterId": "w", "remainingMs": 40}}),
        ], reconnect)

    def test_invalid_raw_inputs_and_exact_capability_are_rejected(self):
        client = OpenBrowserUseClient("unused")
        for value in (True, 0, -1, 1.5, 120001, float("nan"), float("inf")):
            with self.assertRaises(ValueError):
                OpenBrowserUseBrowser(client).tab(9).expect_file_chooser(timeout_ms=value)
        for tab_id in (True, -1, 1.5, 9007199254740992, float("inf")):
            with self.assertRaises(ValueError):
                client.request("armFileChooserWait", {"tabId": tab_id})
        for tab_id in (0, 9007199254740991):
            file_chooser_params("armFileChooserWait", {"tabId": tab_id})
        with self.assertRaises(ValueError):
            client.request("armFileChooserWait", {"tabId": 9, "timeoutMs": None})
        with self.assertRaises(ValueError):
            client.request("collectFileChooserWait", {"tabId": 9, "waiterId": "w", "timeoutMs": 1})
        self.assertIsNone(client._socket)

        def exercise(c):
            for method in ("armFileChooserWait", "collectFileChooserWait", "cancelFileChooserWait"):
                with self.assertRaisesRegex(RuntimeError, "OBU_FILE_CHOOSER_WAIT_UNSUPPORTED"):
                    c.request(method, {"tabId": 9, **({} if method.startswith("arm") else {"waiterId": "w"})})

        self.serve([
            ("getInfo", NOOP, {"result": {"metadata": {"turnLifecycleVersion": 1, "fileChooserWaitVersion": True}}}),
            ("getControlState", NOOP, self.state(7)),
        ], exercise)

    def test_wire_ack_cannot_expand_actual_budget_and_results_are_strict(self):
        def expanded(client):
            with self.assertRaisesRegex(RuntimeError, "acknowledgement"):
                OpenBrowserUseBrowser(client).tab(9).expect_file_chooser(timeout_ms=1000)

        self.serve([
            ("getInfo", lambda p: time.sleep(0.03), INFO), ("getControlState", NOOP, self.state(7)),
            ("armFileChooserWait", lambda p: self.assertLess(p["timeoutMs"], 1000), {"result": {"waiterId": "w", "remainingMs": 1000}}),
        ], expanded)

        def malformed(client):
            wait = OpenBrowserUseBrowser(client).tab(9).expect_file_chooser()
            with self.assertRaisesRegex(RuntimeError, "Invalid file chooser wait result"):
                wait.result()
            with self.assertRaisesRegex(RuntimeError, "cancellation acknowledgement"):
                wait.cancel()

        self.serve([
            ("getInfo", NOOP, INFO), ("getControlState", NOOP, self.state(7)),
            ("armFileChooserWait", NOOP, {"result": {"waiterId": "w", "remainingMs": 500}}),
            ("collectFileChooserWait", NOOP, {"result": {**CHOOSER, "isMultiple": 1}}),
            ("cancelFileChooserWait", NOOP, {"result": {"ok": True}}),
        ], malformed)
        for value in (True, 0, -1, 1001, float("nan"), float("inf")):
            with self.assertRaisesRegex(RuntimeError, "acknowledgement"):
                file_chooser_ack({"waiterId": "w", "remainingMs": value}, 1000)
        for value in ({**CHOOSER, "extra": True}, {**CHOOSER, "fileChooserId": "界" * 43}, {"fileChooserId": "", "isMultiple": False}):
            with self.assertRaisesRegex(RuntimeError, "Invalid file chooser wait result"):
                file_chooser_result(value)


if __name__ == "__main__":
    unittest.main()
