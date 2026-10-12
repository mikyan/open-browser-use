import threading
import time
import unittest

import test_lifecycle as lifecycle
from open_browser_use import OpenBrowserUseBrowser, OpenBrowserUseClient
from open_browser_use._page_waits import page_wait_ack, page_wait_params


INFO = {"result": {"metadata": {"turnLifecycleVersion": 1, "pageWaitVersion": 1}}}
DOWNLOAD = {"tabId": 12}
NOOP = lambda p: None


class PageWaitTest(unittest.TestCase):
    serve = lifecycle.ControlLifecycleTest.serve
    state = lifecycle.ControlLifecycleTest.state

    def test_expired_result_does_not_send_and_cancellation_can_retry(self):
        def check(p):
            self.assertEqual((p["turn_id"], p["control_epoch"], p["tabId"], p["waiterId"]), ("initial", 7, 9, "w"))
            self.assertNotIn("timeoutMs", p)

        def exercise(client):
            wait = OpenBrowserUseBrowser(client).tab(9).expect_page(timeout_ms=1000)
            time.sleep(0.03)
            with self.assertRaisesRegex(TimeoutError, "deadline expired"):
                wait.result()
            wait.cancel()
            wait.cancel()

        self.serve([
            ("getInfo", NOOP, INFO), ("getControlState", NOOP, self.state(7)),
            ("armPageWait", NOOP, {"result": {"waiterId": "w", "remainingMs": 20}}),
            ("cancelPageWait", check, {"result": {}}), ("cancelPageWait", check, {"result": {}}),
        ], exercise)

    def test_concurrent_result_is_rejected_before_a_second_collect(self):
        entered, release = threading.Event(), threading.Event()

        def collect(p):
            entered.set()
            self.assertTrue(release.wait(1))

        def exercise(client):
            wait = OpenBrowserUseBrowser(client).tab(9).expect_page()
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
                with self.assertRaisesRegex(RuntimeError, "OBU_PAGE_WAIT_CONFLICT"):
                    wait.result()
            finally:
                release.set()
                thread.join(1)
            self.assertFalse(thread.is_alive())
            self.assertEqual(errors, [])
            self.assertEqual([value.id for value in values], [DOWNLOAD["tabId"]])
            with self.assertRaisesRegex(RuntimeError, "OBU_PAGE_WAIT_INVALID"):
                wait.result()

        self.serve([
            ("getInfo", NOOP, INFO), ("getControlState", NOOP, self.state(7)),
            ("armPageWait", NOOP, {"result": {"waiterId": "w", "remainingMs": 1000}}),
            ("collectPageWait", collect, {"result": DOWNLOAD}),
        ], exercise)

    def test_invalid_raw_inputs_and_exact_capability_are_rejected(self):
        client = OpenBrowserUseClient("unused")
        for value in (True, 0, -1, 1.5, 120001, float("nan"), float("inf")):
            with self.assertRaises(ValueError):
                OpenBrowserUseBrowser(client).tab(9).expect_page(timeout_ms=value)
        for tab_id in (True, -1, 1.5, 9007199254740992, float("inf")):
            with self.assertRaises(ValueError):
                client.request("armPageWait", {"tabId": tab_id})
        for tab_id in (0, 9007199254740991):
            page_wait_params("armPageWait", {"tabId": tab_id})
        for waiter_id in (None, "", 1, "界" * 43):
            with self.assertRaises(ValueError):
                client.request("collectPageWait", {"tabId": 9, "waiterId": waiter_id})
        for scope in ({"session_id": ""}, {"turn_id": "界" * 1366}, {"control_epoch": 0}, {"control_epoch": True}):
            with self.assertRaises(ValueError):
                client.request("armPageWait", {"tabId": 9, **scope})
        with self.assertRaises(ValueError):
            client.request("armPageWait", {"tabId": 9, "timeoutMs": None})
        with self.assertRaises(ValueError):
            client.request("collectPageWait", {"tabId": 9, "waiterId": "w", "timeoutMs": 1})
        self.assertIsNone(client._socket)

        def exercise(c):
            for method in ("armPageWait", "collectPageWait", "cancelPageWait"):
                with self.assertRaisesRegex(RuntimeError, "OBU_PAGE_WAIT_UNSUPPORTED"):
                    c.request(method, {"tabId": 9, **({} if method.startswith("arm") else {"waiterId": "w"})})

        self.serve([
            ("getInfo", NOOP, {"result": {"metadata": {"turnLifecycleVersion": 1, "pageWaitVersion": True}}}),
            ("getControlState", NOOP, self.state(7)),
        ], exercise)

    def test_wire_ack_cannot_expand_actual_budget_and_results_are_strict(self):
        def expanded(client):
            with self.assertRaisesRegex(RuntimeError, "acknowledgement"):
                OpenBrowserUseBrowser(client).tab(9).expect_page(timeout_ms=1000)

        self.serve([
            ("getInfo", lambda p: time.sleep(0.03), INFO), ("getControlState", NOOP, self.state(7)),
            ("armPageWait", lambda p: self.assertLess(p["timeoutMs"], 1000), {"result": {"waiterId": "w", "remainingMs": 1000}}),
        ], expanded)

        def malformed(client):
            wait = OpenBrowserUseBrowser(client).tab(9).expect_page()
            with self.assertRaisesRegex(RuntimeError, "Invalid page wait result"):
                wait.result()
            with self.assertRaisesRegex(RuntimeError, "cancellation acknowledgement"):
                wait.cancel()

        self.serve([
            ("getInfo", NOOP, INFO), ("getControlState", NOOP, self.state(7)),
            ("armPageWait", NOOP, {"result": {"waiterId": "w", "remainingMs": 500}}),
            ("collectPageWait", NOOP, {"result": {"tabId": True}}),
            ("cancelPageWait", NOOP, {"result": {"ok": True}}),
        ], malformed)
        for value in (True, 0, -1, 1001, float("nan"), float("inf")):
            with self.assertRaisesRegex(RuntimeError, "acknowledgement"):
                page_wait_ack({"waiterId": "w", "remainingMs": value}, 1000)
        for waiter_id in ("", "界" * 43, 1):
            with self.assertRaisesRegex(RuntimeError, "acknowledgement"):
                page_wait_ack({"waiterId": waiter_id, "remainingMs": 1}, 1000)

    def test_ended_scope_rejects_without_rebinding_or_rearming(self):
        def old(p):
            self.assertEqual((p["turn_id"], p["control_epoch"], p["tabId"], p["waiterId"]), ("initial", 7, 9, "w"))

        def exercise(client):
            wait = OpenBrowserUseBrowser(client).tab(9).expect_page()
            client.begin_turn()
            with self.assertRaisesRegex(RuntimeError, "OBU_STALE_CONTROL_EPOCH"):
                wait.result()
            with self.assertRaisesRegex(RuntimeError, "OBU_STALE_CONTROL_EPOCH"):
                wait.cancel()

        self.serve([
            ("getInfo", NOOP, INFO), ("getControlState", NOOP, self.state(7)),
            ("armPageWait", NOOP, {"result": {"waiterId": "w", "remainingMs": 500}}),
            ("getControlState", NOOP, self.state(8)),
            ("collectPageWait", old, {"error": {"message": "OBU_STALE_CONTROL_EPOCH"}}),
            ("cancelPageWait", old, {"error": {"message": "OBU_STALE_CONTROL_EPOCH"}}),
        ], exercise)

    def test_cancel_consumes_only_observer_and_raw_responses_are_validated(self):
        def exercise(client):
            wait = OpenBrowserUseBrowser(client).tab(9).expect_page()
            wait.cancel()
            with self.assertRaisesRegex(RuntimeError, "OBU_PAGE_WAIT_INVALID"):
                wait.result()
            with self.assertRaisesRegex(RuntimeError, "result"):
                client.request("collectPageWait", {"tabId": 9, "waiterId": "w"})
            with self.assertRaisesRegex(RuntimeError, "cancellation acknowledgement"):
                client.request("cancelPageWait", {"tabId": 9, "waiterId": "w"})

        self.serve([
            ("getInfo", NOOP, INFO), ("getControlState", NOOP, self.state(7)),
            ("armPageWait", NOOP, {"result": {"waiterId": "w", "remainingMs": 500}}),
            ("cancelPageWait", NOOP, {"result": {}}),
            ("collectPageWait", NOOP, {"result": {"tabId": 12, "extra": True}}),
            ("cancelPageWait", NOOP, {"result": {"cancelled": True}}),
        ], exercise)


    def test_child_is_real_tab_and_all_paths_reject_after_new_turn(self):
        def child_scope(p):
            self.assertEqual((p["tabId"], p["turn_id"], p["control_epoch"]), (12, "initial", 7))
            self.assertNotIn("waiterId", p)

        def exercise(client):
            wait = OpenBrowserUseBrowser(client).tab(9).playwright.expect_page()
            child = wait.result()
            self.assertEqual(child.id, 12)
            locator = child.locator("#once")
            locator.click()
            client.begin_turn()
            for action in (locator.click, lambda: child.evaluate("location.href"), child.close,
                           child.expect_page, lambda: child.browser.client.request("getTabs"), child.browser.client.begin_turn):
                with self.assertRaisesRegex(RuntimeError, "OBU_STALE_CONTROL_EPOCH"):
                    action()
            wait.cancel()

        self.serve([
            ("getInfo", NOOP, INFO), ("getControlState", NOOP, self.state(7)),
            ("armPageWait", NOOP, {"result": {"waiterId": "w", "remainingMs": 1000}}),
            ("collectPageWait", NOOP, {"result": {"tabId": 12}}),
            ("browserAction", child_scope, {"result": {"value": None, "engine": {"name": "playwright-crx", "version": "0.15.0", "playwrightVersion": "1.53.0"}}}),
            ("getControlState", NOOP, self.state(8)),
            ("cancelPageWait", lambda p: self.assertEqual(p["control_epoch"], 7), {"result": {}}),
        ], exercise)

    def test_late_ack_and_collect_do_not_renew_original_budget(self):
        from unittest.mock import patch

        class Stream:
            def settimeout(self, timeout): pass
            def sendall(self, frame): pass
            def close(self): pass

        for method, response in (("armPageWait", {"waiterId": "w", "remainingMs": 1}), ("collectPageWait", {"tabId": 12})):
            client = OpenBrowserUseClient("unused")
            client._socket = Stream()
            client._lifecycle_version = 1
            client._control_epoch = 7
            client._page_wait_version = 1
            params = {"tabId": 9, **({"timeoutMs": 100} if method == "armPageWait" else {"waiterId": "w"})}

            def late_read(*args, **kwargs):
                time.sleep(.03)
                return {"id": 1, "result": response}

            with patch("open_browser_use.client.read_frame", late_read):
                with self.assertRaises(TimeoutError):
                    client._request(method, params, timeout=.01)
            self.assertEqual(client._next_id, 2)
            client.close()


if __name__ == "__main__":
    unittest.main()
