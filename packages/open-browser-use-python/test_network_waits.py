import copy
import time
import unittest

import test_lifecycle as lifecycle
from open_browser_use import OpenBrowserUseBrowser, OpenBrowserUseClient
from open_browser_use._network_waits import network_ack, network_result


INFO = {"result": {"metadata": {"turnLifecycleVersion": 1, "networkWaitVersion": 1}}}


def result(event="response"):
    return {"event": event, "requestId": "request-1", "url": "http://fixture.test/api", "method": "pOsT",
            "resourceType": "fetch", "frameUrl": "http://fixture.test/", **({"status": 503, "statusText": "Unavailable"} if event == "response" else {})}


class NetworkWaitTest(unittest.TestCase):
    serve = lifecycle.ControlLifecycleTest.serve
    state = lifecycle.ControlLifecycleTest.state

    def test_sequential_ready_trigger_collect_cancel_and_original_epoch(self):
        noop = lambda p: None
        old = lambda p: self.assertEqual((p["turn_id"], p["control_epoch"]), ("initial", 7))

        def arm(p):
            old(p)
            self.assertEqual(p["match"], {"url": "http://fixture.test/api", "method": "pOsT", "status": 503})
            self.assertTrue(0 < p["timeoutMs"] <= 1000)

        def collect(p):
            old(p)
            self.assertEqual(p["waiterId"], "w")
            self.assertNotIn("timeoutMs", p)

        def exercise(client):
            tab = OpenBrowserUseBrowser(client).tab(9)
            wait = tab.playwright.expect_response({"url": "http://fixture.test/api", "method": "pOsT", "status": 503}, timeout_ms=1000)
            tab.get_by_role("button", name="Save").click()
            time.sleep(0.015)
            self.assertEqual(wait.result(), result())
            self.assertEqual(wait.result(timeout_ms=1000), result())
            wait.cancel()
            client.begin_turn()
            with self.assertRaisesRegex(RuntimeError, "OBU_STALE_CONTROL_EPOCH"):
                wait.result()
            self.assertEqual(client._control_epoch, 8)

        self.serve([
            ("getInfo", noop, INFO), ("getControlState", noop, self.state(7)),
            ("armNetworkWait", arm, {"result": {"waiterId": "w", "remainingMs": 10}}),
            ("browserAction", old, {"result": {"value": None, "engine": {"name": "playwright-crx", "version": "0.15.0", "playwrightVersion": "1.53.0"}}}),
            ("collectNetworkWait", collect, {"result": result()}),
            ("collectNetworkWait", collect, {"result": result()}), ("cancelNetworkWait", collect, {"result": {}}),
            ("getControlState", noop, self.state(8)),
            ("collectNetworkWait", collect, {"error": {"message": "OBU_STALE_CONTROL_EPOCH"}}),
        ], exercise)

    def test_slow_negotiation_consumes_short_high_level_and_raw_budget(self):
        for raw in (False, True):
            def exercise(client):
                client.timeout = 10
                with self.assertRaisesRegex(TimeoutError, "deadline"):
                    if raw:
                        client.request("armNetworkWait", {"tabId": 9, "event": "request", "match": {"url": "x"}, "timeoutMs": 100})
                    else:
                        OpenBrowserUseBrowser(client).tab(9).expect_request({"url": "x"}, timeout_ms=100)
            self.serve([
                ("getInfo", lambda p: time.sleep(0.25), INFO),
                ("getControlState", lambda p: None, self.state(7)),
            ], exercise)

    def test_invalid_inputs_and_unsupported_extension(self):
        client = OpenBrowserUseClient("unused")
        tab = OpenBrowserUseBrowser(client).tab(9)
        for match in ({"url": ""}, {"url": "🙂" * 1025}, {"url": "x", "method": "é" * 65},
                      {"url": "x", "status": 200}, {"url": "x", "urlMatch": "regex"}, {"url": "x", "predicate": "true"}):
            with self.subTest(match=match), self.assertRaises(ValueError):
                tab.expect_request(match)
        for timeout in (True, 0, -1, 1.5, 120001):
            with self.assertRaises(ValueError):
                tab.expect_request({"url": "x"}, timeout_ms=timeout)
        self.assertIsNone(client._socket)

        def exercise(c):
            with self.assertRaisesRegex(RuntimeError, "OBU_NETWORK_WAIT_UNSUPPORTED"):
                OpenBrowserUseBrowser(c).tab(9).expect_response({"url": "x"})
        self.serve([
            ("getInfo", lambda p: None, {"result": {"metadata": {"turnLifecycleVersion": 1}}}),
            ("getControlState", lambda p: None, self.state(7)),
        ], exercise)

    def test_strict_ready_and_result_validation(self):
        for value in ({"waiterId": "", "remainingMs": 1}, {"waiterId": "w", "remainingMs": True},
                      {"waiterId": "w", "remainingMs": 0}, {"waiterId": "w", "remainingMs": 1001},
                      {"waiterId": "w", "remainingMs": 1, "extra": 2}):
            with self.assertRaisesRegex(RuntimeError, "acknowledgement"):
                network_ack(value, 1000)
        original = result()
        for mutation in ({"event": "request"}, {"status": True}, {"status": 99}, {"status": None},
                         {"url": "界" * 1366}, {"truncated": 1}, {"headers": {}}, {"redirectedFrom": ""}):
            with self.subTest(mutation=mutation), self.assertRaisesRegex(RuntimeError, "Invalid network wait result"):
                network_result({**copy.deepcopy(original), **mutation}, "response")
        self.assertEqual(network_result(result("request"), "request"), result("request"))


if __name__ == "__main__":
    unittest.main()
