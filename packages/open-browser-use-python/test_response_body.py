import base64
import unittest
import time
import test_lifecycle as lifecycle
from open_browser_use import OpenBrowserUseBrowser, OpenBrowserUseClient
from open_browser_use._response_body import response_body_params, validate_response_body, MAX_RESPONSE_BODY_BYTES

REF = {"captureId": "diag,[]中文", "requestId": "request-7"}
INFO = {"result": {"metadata": {"turnLifecycleVersion": 1, "responseBodyVersion": 1}}}
def body(data=b"\0\xff\r\n"):
    return {**REF, "encoding": "base64", "data": base64.b64encode(data).decode("ascii"), "byteLength": len(data)}
def envelope(value):
    return {"value": value, "engine": {"name": "playwright-crx", "version": "1", "playwrightVersion": "1", "capabilities": {"responseBody": 1}}}

class ResponseBodyTest(unittest.TestCase):
    serve = lifecycle.ControlLifecycleTest.serve
    state = lifecycle.ControlLifecycleTest.state

    def test_helpers_keep_original_ref_scope_and_binary_result(self):
        def check(p):
            self.assertEqual((p["tabId"], p["turn_id"], p["control_epoch"], p["action"]), (9, "initial", 7, "responseBody"))
            self.assertEqual(p["args"], {**REF, "maxBytes": 32})
            self.assertNotIn("locator", p)
            self.assertTrue(0 < p["timeoutMs"] <= 1000)
        def exercise(client):
            tab = OpenBrowserUseBrowser(client).tab(9)
            for facade in (tab, tab.playwright):
                self.assertEqual(facade.response_body(capture_id=REF["captureId"], request_id=REF["requestId"], max_bytes=32, timeout_ms=1000), body())
        self.serve([("getInfo", lambda p: None, INFO), ("getControlState", lambda p: None, self.state(7)),
                    ("browserAction", check, {"result": envelope(body())}), ("browserAction", check, {"result": envelope(body())})], exercise)

    def test_bad_arguments_never_connect(self):
        client = OpenBrowserUseClient("unused")
        tab = OpenBrowserUseBrowser(client).tab(9)
        for changes in ({"capture_id": ""}, {"request_id": "\ud800"}, {"capture_id": "中" * 43}, {"max_bytes": 0},
                        {"max_bytes": True}, {"max_bytes": MAX_RESPONSE_BODY_BYTES+1}, {"timeout_ms": 1.5}, {"timeout_ms": True}):
            args = {"capture_id": REF["captureId"], "request_id": REF["requestId"], **changes}
            with self.subTest(args=args), self.assertRaisesRegex(ValueError, "OBU_RESPONSE_BODY_INVALID"):
                tab.response_body(**args)
        for changes in ({"locator": []}, {"args": {**REF, "maxBytes": None}}, {"timeoutMs": None}, {"args": {**REF, "url": "x"}}):
            with self.assertRaisesRegex(ValueError, "OBU_RESPONSE_BODY_INVALID"):
                client.request("browserAction", {"tabId": 9, "action": "responseBody", "args": REF, **changes})
        self.assertIsNone(client._socket)
        self.assertEqual(response_body_params("c", "r")["args"]["maxBytes"], 1048576)

    def test_exact_schema_refs_and_canonical_bytes(self):
        good = body(b"\xff")
        self.assertEqual(validate_response_body(body(b""), **dict(capture_id=REF["captureId"], request_id=REF["requestId"], maximum=1)), body(b""))
        for value in (None, {}, {**good, "extra": 1}, {**good, "captureId": "wrong"}, {**good, "requestId": "wrong"},
                      {**good, "data": "/x=="}, {**good, "data": "_w=="}, {**good, "data": "/w=\n"},
                      {**good, "byteLength": True}, {**good, "byteLength": 0}, {**good, "encoding": "utf8"}):
            with self.subTest(value=value), self.assertRaisesRegex(RuntimeError, "OBU_RESPONSE_BODY_FAILED"):
                validate_response_body(value, REF["captureId"], REF["requestId"], 32)
        with self.assertRaisesRegex(RuntimeError, "FAILED"):
            validate_response_body(body(), REF["captureId"], REF["requestId"], 3)

    def test_explicit_epoch_requires_metadata_and_raw_results_are_checked(self):
        for version in (None, True, 2):
            def exercise(client):
                with self.assertRaisesRegex(RuntimeError, "UNSUPPORTED"):
                    client.request("browserAction", {"tabId": 9, "action": "responseBody", "args": REF, "control_epoch": 7}, timeout=2)
            self.serve([("getInfo", lambda p: None, {"result": {"metadata": {"responseBodyVersion": version}}})], exercise)
        for result in (envelope({**body(), "requestId": "wrong"}), {**envelope(body()), "engine": {**envelope(body())["engine"], "capabilities": {"responseBody": True}}}):
            def exercise(client):
                with self.assertRaisesRegex(RuntimeError, "FAILED|UNSUPPORTED"):
                    client.request("browserAction", {"tabId": 9, "action": "responseBody", "args": REF, "control_epoch": 7}, timeout=2)
            self.serve([("getInfo", lambda p: None, INFO), ("browserAction", lambda p: None, {"result": result})], exercise)

    def test_original_backend_failure_is_not_replayed(self):
        def exercise(client):
            with self.assertRaisesRegex(RuntimeError, "OBU_RESPONSE_BODY_EXPIRED"):
                OpenBrowserUseBrowser(client).tab(9).response_body(capture_id=REF["captureId"], request_id=REF["requestId"])
        self.serve([("getInfo", lambda p: None, INFO), ("getControlState", lambda p: None, self.state(7)),
                    ("browserAction", lambda p: None, {"error": {"message": "OBU_RESPONSE_BODY_EXPIRED"}})], exercise)

    def test_discovery_uses_original_budget_and_captures_raw_reference(self):
        params = {"tabId": 9, "action": "responseBody", "args": dict(REF), "control_epoch": 7, "timeoutMs": 1000}
        def exercise(client):
            self.assertEqual(client.request("browserAction", params, timeout=2)["value"], body())
        self.serve([("getInfo", lambda p: params["args"].update(requestId="changed"), INFO),
                    ("browserAction", lambda p: self.assertEqual(p["args"], REF), {"result": envelope(body())})], exercise)
        def expired(client):
            with self.assertRaises(TimeoutError):
                client.request("browserAction", {"tabId": 9, "action": "responseBody", "args": REF, "control_epoch": 7, "timeoutMs": 10}, timeout=2)
        self.serve([("getInfo", lambda p: time.sleep(.08), INFO)], expired)

if __name__ == "__main__":
    unittest.main()
