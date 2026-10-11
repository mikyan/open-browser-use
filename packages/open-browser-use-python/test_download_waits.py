import threading
import time
import unittest

import test_lifecycle as lifecycle
from open_browser_use import OpenBrowserUseBrowser, OpenBrowserUseClient
from open_browser_use._download_waits import download_wait_ack, download_wait_params


INFO = {"result": {"metadata": {"turnLifecycleVersion": 1, "downloadWaitVersion": 1}}}
DOWNLOAD = {"downloadId": "page-guid"}
NOOP = lambda p: None


class DownloadWaitTest(unittest.TestCase):
    serve = lifecycle.ControlLifecycleTest.serve
    state = lifecycle.ControlLifecycleTest.state

    def test_ready_trigger_collect_and_download_binding_are_separate(self):
        def old(p):
            self.assertEqual((p["turn_id"], p["control_epoch"], p["tabId"]), ("initial", 7, 9))

        def handle(p):
            old(p)
            self.assertEqual(p["waiterId"], "w")
            self.assertNotIn("timeoutMs", p)
            self.assertNotIn("downloadId", p)

        def download(p):
            old(p)
            self.assertEqual(p["downloadId"], "page-guid")
            self.assertNotIn("waiterId", p)

        def exercise(client):
            tab = OpenBrowserUseBrowser(client).tab(9)
            wait = tab.playwright.expect_download(timeout_ms=1000)
            self.assertEqual((wait.waiter_id, wait.remaining_ms), ("w", 500))
            tab.get_by_role("button", name="Download").click()
            result = wait.result()
            self.assertEqual(result.download_id, "page-guid")
            wait.cancel()
            with self.assertRaisesRegex(RuntimeError, "OBU_DOWNLOAD_WAIT_INVALID"):
                wait.result()
            client.begin_turn()
            with self.assertRaisesRegex(RuntimeError, "OBU_DOWNLOAD_PATH_UNAVAILABLE"):
                result.path()
            with self.assertRaisesRegex(RuntimeError, "OBU_DOWNLOAD_CANCEL_UNSUPPORTED"):
                result.cancel()
            self.assertEqual(client._control_epoch, 8)

        self.serve([
            ("getInfo", NOOP, {"result": {"metadata": {"turnLifecycleVersion": 1, "downloadWaitVersion": 1, "directDownloadsVersion": 1}}}),
            ("getControlState", NOOP, self.state(7)),
            ("armDownloadWait", old, {"result": {"waiterId": "w", "remainingMs": 500}}),
            ("browserAction", old, {"result": {"value": None, "engine": {"name": "playwright-crx", "version": "0.15.0", "playwrightVersion": "1.53.0"}}}),
            ("collectDownloadWait", handle, {"result": DOWNLOAD}), ("cancelDownloadWait", handle, {"result": {}}),
            ("getControlState", NOOP, self.state(8)),
            ("downloadPath", download, {"error": {"message": "OBU_DOWNLOAD_PATH_UNAVAILABLE"}}),
            ("cancelDownload", download, {"error": {"message": "OBU_DOWNLOAD_CANCEL_UNSUPPORTED"}}),
        ], exercise)

    def test_expired_result_does_not_send_and_cancellation_can_retry(self):
        def check(p):
            self.assertEqual((p["turn_id"], p["control_epoch"], p["tabId"], p["waiterId"]), ("initial", 7, 9, "w"))
            self.assertNotIn("timeoutMs", p)

        def exercise(client):
            wait = OpenBrowserUseBrowser(client).tab(9).expect_download(timeout_ms=1000)
            time.sleep(0.03)
            with self.assertRaisesRegex(TimeoutError, "deadline expired"):
                wait.result()
            wait.cancel()
            wait.cancel()

        self.serve([
            ("getInfo", NOOP, INFO), ("getControlState", NOOP, self.state(7)),
            ("armDownloadWait", NOOP, {"result": {"waiterId": "w", "remainingMs": 20}}),
            ("cancelDownloadWait", check, {"result": {}}), ("cancelDownloadWait", check, {"result": {}}),
        ], exercise)

    def test_concurrent_result_is_rejected_before_a_second_collect(self):
        entered, release = threading.Event(), threading.Event()

        def collect(p):
            entered.set()
            self.assertTrue(release.wait(1))

        def exercise(client):
            wait = OpenBrowserUseBrowser(client).tab(9).expect_download()
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
                with self.assertRaisesRegex(RuntimeError, "OBU_DOWNLOAD_WAIT_CONFLICT"):
                    wait.result()
            finally:
                release.set()
                thread.join(1)
            self.assertFalse(thread.is_alive())
            self.assertEqual(errors, [])
            self.assertEqual([value.download_id for value in values], [DOWNLOAD["downloadId"]])
            with self.assertRaisesRegex(RuntimeError, "OBU_DOWNLOAD_WAIT_INVALID"):
                wait.result()

        self.serve([
            ("getInfo", NOOP, INFO), ("getControlState", NOOP, self.state(7)),
            ("armDownloadWait", NOOP, {"result": {"waiterId": "w", "remainingMs": 1000}}),
            ("collectDownloadWait", collect, {"result": DOWNLOAD}),
        ], exercise)

    def test_slow_bootstrap_and_reconnect_cannot_use_response_reserve_to_send_late(self):
        for raw in (False, True):
            def exercise(client):
                with self.assertRaisesRegex(TimeoutError, "deadline"):
                    if raw:
                        client.request("armDownloadWait", {"tabId": 9, "timeoutMs": 30})
                    else:
                        OpenBrowserUseBrowser(client).tab(9).expect_download(timeout_ms=30)

            self.serve([
                ("getInfo", lambda p: time.sleep(0.08), INFO), ("getControlState", NOOP, self.state(7)),
            ], exercise)

        def reconnect(client):
            wait = OpenBrowserUseBrowser(client).tab(9).expect_download()
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
            ("armDownloadWait", NOOP, {"result": {"waiterId": "w", "remainingMs": 40}}),
        ], reconnect)

    def test_invalid_raw_inputs_and_exact_capability_are_rejected(self):
        client = OpenBrowserUseClient("unused")
        for value in (True, 0, -1, 1.5, 120001, float("nan"), float("inf")):
            with self.assertRaises(ValueError):
                OpenBrowserUseBrowser(client).tab(9).expect_download(timeout_ms=value)
        for tab_id in (True, -1, 1.5, 9007199254740992, float("inf")):
            with self.assertRaises(ValueError):
                client.request("armDownloadWait", {"tabId": tab_id})
        for tab_id in (0, 9007199254740991):
            download_wait_params("armDownloadWait", {"tabId": tab_id})
        for waiter_id in (None, "", 1, "界" * 43):
            with self.assertRaises(ValueError):
                client.request("collectDownloadWait", {"tabId": 9, "waiterId": waiter_id})
        for scope in ({"session_id": ""}, {"turn_id": "界" * 1366}, {"control_epoch": 0}, {"control_epoch": True}):
            with self.assertRaises(ValueError):
                client.request("armDownloadWait", {"tabId": 9, **scope})
        with self.assertRaises(ValueError):
            client.request("armDownloadWait", {"tabId": 9, "timeoutMs": None})
        with self.assertRaises(ValueError):
            client.request("collectDownloadWait", {"tabId": 9, "waiterId": "w", "timeoutMs": 1})
        self.assertIsNone(client._socket)

        def exercise(c):
            for method in ("armDownloadWait", "collectDownloadWait", "cancelDownloadWait"):
                with self.assertRaisesRegex(RuntimeError, "OBU_DOWNLOAD_WAIT_UNSUPPORTED"):
                    c.request(method, {"tabId": 9, **({} if method.startswith("arm") else {"waiterId": "w"})})

        self.serve([
            ("getInfo", NOOP, {"result": {"metadata": {"turnLifecycleVersion": 1, "downloadWaitVersion": True}}}),
            ("getControlState", NOOP, self.state(7)),
        ], exercise)

    def test_wire_ack_cannot_expand_actual_budget_and_results_are_strict(self):
        def expanded(client):
            with self.assertRaisesRegex(RuntimeError, "acknowledgement"):
                OpenBrowserUseBrowser(client).tab(9).expect_download(timeout_ms=1000)

        self.serve([
            ("getInfo", lambda p: time.sleep(0.03), INFO), ("getControlState", NOOP, self.state(7)),
            ("armDownloadWait", lambda p: self.assertLess(p["timeoutMs"], 1000), {"result": {"waiterId": "w", "remainingMs": 1000}}),
        ], expanded)

        def malformed(client):
            wait = OpenBrowserUseBrowser(client).tab(9).expect_download()
            with self.assertRaisesRegex(RuntimeError, "Invalid download acknowledgement"):
                wait.result()
            with self.assertRaisesRegex(RuntimeError, "cancellation acknowledgement"):
                wait.cancel()

        self.serve([
            ("getInfo", NOOP, INFO), ("getControlState", NOOP, self.state(7)),
            ("armDownloadWait", NOOP, {"result": {"waiterId": "w", "remainingMs": 500}}),
            ("collectDownloadWait", NOOP, {"result": {"downloadId": 1}}),
            ("cancelDownloadWait", NOOP, {"result": {"ok": True}}),
        ], malformed)
        for value in (True, 0, -1, 1001, float("nan"), float("inf")):
            with self.assertRaisesRegex(RuntimeError, "acknowledgement"):
                download_wait_ack({"waiterId": "w", "remainingMs": value}, 1000)
        for waiter_id in ("", "界" * 43, 1):
            with self.assertRaisesRegex(RuntimeError, "acknowledgement"):
                download_wait_ack({"waiterId": waiter_id, "remainingMs": 1}, 1000)

    def test_ended_scope_rejects_without_rebinding_or_rearming(self):
        def old(p):
            self.assertEqual((p["turn_id"], p["control_epoch"], p["tabId"], p["waiterId"]), ("initial", 7, 9, "w"))

        def exercise(client):
            wait = OpenBrowserUseBrowser(client).tab(9).expect_download()
            client.begin_turn()
            with self.assertRaisesRegex(RuntimeError, "OBU_STALE_CONTROL_EPOCH"):
                wait.result()
            with self.assertRaisesRegex(RuntimeError, "OBU_STALE_CONTROL_EPOCH"):
                wait.cancel()

        self.serve([
            ("getInfo", NOOP, INFO), ("getControlState", NOOP, self.state(7)),
            ("armDownloadWait", NOOP, {"result": {"waiterId": "w", "remainingMs": 500}}),
            ("getControlState", NOOP, self.state(8)),
            ("collectDownloadWait", old, {"error": {"message": "OBU_STALE_CONTROL_EPOCH"}}),
            ("cancelDownloadWait", old, {"error": {"message": "OBU_STALE_CONTROL_EPOCH"}}),
        ], exercise)

    def test_late_ready_ack_does_not_extend_original_deadline(self):
        def exercise(client):
            with self.assertRaisesRegex(TimeoutError, "deadline expired"):
                OpenBrowserUseBrowser(client).tab(9).expect_download(timeout_ms=40)

        self.serve([
            ("getInfo", NOOP, INFO), ("getControlState", NOOP, self.state(7)),
            ("armDownloadWait", lambda p: time.sleep(0.08), {"result": {"waiterId": "w", "remainingMs": 10}}),
        ], exercise)

    def test_cancel_consumes_only_observer_and_raw_responses_are_validated(self):
        def exercise(client):
            wait = OpenBrowserUseBrowser(client).tab(9).expect_download()
            wait.cancel()
            with self.assertRaisesRegex(RuntimeError, "OBU_DOWNLOAD_WAIT_INVALID"):
                wait.result()
            with self.assertRaisesRegex(RuntimeError, "acknowledgement"):
                client.request("collectDownloadWait", {"tabId": 9, "waiterId": "w"})
            with self.assertRaisesRegex(RuntimeError, "cancellation acknowledgement"):
                client.request("cancelDownloadWait", {"tabId": 9, "waiterId": "w"})

        self.serve([
            ("getInfo", NOOP, INFO), ("getControlState", NOOP, self.state(7)),
            ("armDownloadWait", NOOP, {"result": {"waiterId": "w", "remainingMs": 500}}),
            ("cancelDownloadWait", NOOP, {"result": {}}),
            ("collectDownloadWait", NOOP, {"result": {"downloadId": "page-guid", "extra": True}}),
            ("cancelDownloadWait", NOOP, {"result": {"cancelled": True}}),
        ], exercise)


if __name__ == "__main__":
    unittest.main()
