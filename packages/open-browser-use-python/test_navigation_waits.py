import time
import unittest

import test_lifecycle as lifecycle
from open_browser_use import OpenBrowserUseBrowser, OpenBrowserUseClient, OpenBrowserUseNavigationWait
from open_browser_use._navigation_waits import navigation_ack

INFO = {"result": {"metadata": {"turnLifecycleVersion": 1, "navigationWaitVersion": 1}}}


class NavigationWaitTest(unittest.TestCase):
    serve = lifecycle.ControlLifecycleTest.serve
    state = lifecycle.ControlLifecycleTest.state

    def test_ready_trigger_collect_cancel_and_original_binding(self):
        noop = lambda p: None
        old = lambda p: self.assertEqual((p["turn_id"], p["control_epoch"]), ("initial", 7))

        def arm(p):
            old(p)
            self.assertEqual((p["event"], p["url"], p["waitUntil"]), ("url", "**/next", "commit"))
            self.assertTrue(0 < p["timeoutMs"] <= 1000)
            self.assertNotIn("state", p)

        def collect(p):
            old(p)
            self.assertEqual(p["waiterId"], "w")
            self.assertNotIn("timeoutMs", p)

        def exercise(client):
            tab = OpenBrowserUseBrowser(client).tab(9)
            pending = tab.playwright.expect_url("**/next", wait_until="commit", timeout_ms=1000)
            tab.get_by_role("button", name="Next").click()
            time.sleep(0.015)
            self.assertIsNone(pending.result())
            self.assertIsNone(pending.result(timeout_ms=1000))
            pending.cancel()
            client.begin_turn()
            with self.assertRaisesRegex(RuntimeError, "OBU_STALE_CONTROL_EPOCH"):
                pending.result()

        self.serve([
            ("getInfo", noop, INFO), ("getControlState", noop, self.state(7)),
            ("armNavigationWait", arm, {"result": {"waiterId": "w", "remainingMs": 10}}),
            ("browserAction", old, {"result": {"value": None, "engine": {"name": "playwright-crx", "version": "0.15.0", "playwrightVersion": "1.53.0"}}}),
            ("collectNavigationWait", collect, {"result": {}}),
            ("collectNavigationWait", collect, {"result": {}}), ("cancelNavigationWait", collect, {"result": {}}),
            ("getControlState", noop, self.state(8)),
            ("collectNavigationWait", collect, {"error": {"message": "OBU_STALE_CONTROL_EPOCH"}}),
        ], exercise)

    def test_load_state_and_short_discovery_budget(self):
        def arm(params):
            self.assertEqual(params["event"], "loadstate")
            self.assertEqual(params["state"], "networkidle")
            self.assertNotIn("url", params)
            self.assertNotIn("waitUntil", params)
        self.serve([
            ("getInfo", lambda p: None, INFO), ("getControlState", lambda p: None, self.state(7)),
            ("armNavigationWait", arm, {"result": {"waiterId": "load", "remainingMs": 1000}}),
            ("collectNavigationWait", lambda p: None, {"result": {}}),
        ], lambda client: OpenBrowserUseBrowser(client).tab(9).playwright.expect_load_state(state="networkidle").result())
        for raw in (False, True):
            def exercise(client):
                client.timeout = 10
                with self.assertRaisesRegex(TimeoutError, "deadline"):
                    if raw:
                        client.request("armNavigationWait", {"tabId": 9, "event": "url", "url": "x", "timeoutMs": 100})
                    else:
                        OpenBrowserUseBrowser(client).tab(9).expect_url("x", timeout_ms=100)
            self.serve([
                ("getInfo", lambda p: time.sleep(0.25), INFO),
                ("getControlState", lambda p: None, self.state(7)),
            ], exercise)

    def test_invalid_inputs_unsupported_and_strict_results(self):
        client = OpenBrowserUseClient("unused")
        tab = OpenBrowserUseBrowser(client).tab(9)
        for url in ("", "🙂" * 1025, None):
            with self.assertRaises(ValueError):
                tab.expect_url(url)
        for timeout in (True, 0, -1, 1.5, 120001):
            with self.assertRaises(ValueError):
                tab.expect_url("x", timeout_ms=timeout)
        for state in ("commit", "idle", None):
            with self.assertRaises(ValueError):
                tab.expect_load_state(state=state)
        self.assertIsNone(client._socket)
        def exercise(c):
            with self.assertRaisesRegex(RuntimeError, "OBU_NAVIGATION_WAIT_UNSUPPORTED"):
                OpenBrowserUseBrowser(c).tab(9).expect_url("x")
        self.serve([
            ("getInfo", lambda p: None, {"result": {"metadata": {"turnLifecycleVersion": 1, "navigationWaitVersion": True}}}),
            ("getControlState", lambda p: None, self.state(7)),
        ], exercise)
        for ack in ({"waiterId": "", "remainingMs": 1}, {"waiterId": "w", "remainingMs": True},
                    {"waiterId": "w", "remainingMs": 0}, {"waiterId": "w", "remainingMs": 1001},
                    {"waiterId": "w", "remainingMs": 1, "extra": True}):
            with self.assertRaises(RuntimeError):
                navigation_ack(ack, 1000)
        for value in (None, [], True, {"value": None}):
            pending = OpenBrowserUseNavigationWait("w", 1, lambda method, timeout: value)
            with self.assertRaises(RuntimeError):
                pending.result()
            with self.assertRaises(RuntimeError):
                pending.cancel()
