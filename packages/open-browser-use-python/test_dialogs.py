import threading
import time
import unittest

import test_lifecycle as lifecycle
from open_browser_use import OpenBrowserUseBrowser, OpenBrowserUseClient
from open_browser_use._dialogs import dialog_ack, dialog_decision, dialog_params, dialog_result

INFO = {"result": {"metadata": {"turnLifecycleVersion": 1, "dialogVersion": 1}}}
DECISION = {"type": "prompt", "accept": True, "message": 'false,"中文"\n🙂', "promptText": 'null,"x"\\n🙂'}
RESULT = {"type": "prompt", "message": DECISION["message"], "defaultValue": "original default", "accepted": True, "promptText": DECISION["promptText"]}
NOOP = lambda p: None

class DialogTest(unittest.TestCase):
    serve = lifecycle.ControlLifecycleTest.serve
    state = lifecycle.ControlLifecycleTest.state

    def check_scope(self, params):
        self.assertEqual((params["turn_id"], params["control_epoch"], params["tabId"]), ("initial", 7, 9))

    def check_handle(self, params):
        self.check_scope(params)
        self.assertEqual(params["dialogId"], "original")
        self.assertNotIn("timeoutMs", params)

    def test_typed_ready_trigger_result_and_cleanup_preserve_literal_original_decision(self):
        def arm(params):
            self.check_scope(params)
            self.assertTrue(0 < params["timeoutMs"] <= 1000)
            self.assertEqual({key: params[key] for key in DECISION}, DECISION)

        def exercise(client):
            tab = OpenBrowserUseBrowser(client).tab(9)
            decision = dict(DECISION)
            wait = tab.playwright.expect_dialog(decision, timeout_ms=1000)
            decision["promptText"] = "mutated"
            self.assertEqual(wait.dialog_id, "original")
            self.assertTrue(0 < wait.remaining_ms <= 500)
            tab.locator("#trigger").click()
            self.assertEqual(wait.result(), RESULT)
            wait.cancel()
            with self.assertRaisesRegex(RuntimeError, "OBU_DIALOG_EXPIRED"):
                wait.result()

        self.serve([
            ("getInfo", NOOP, INFO), ("getControlState", NOOP, self.state(7)),
            ("armDialog", arm, {"result": {"dialogId": "original", "remainingMs": 500}}),
            ("browserAction", self.check_scope, {"result": {"value": None, "engine": {"name": "playwright-crx", "version": "0.15.0", "playwrightVersion": "1.53.0"}}}),
            ("collectDialog", self.check_handle, {"result": RESULT}), ("cancelDialog", self.check_handle, {"result": {}}),
        ], exercise)

    def test_raw_methods_preserve_all_types_and_prompt_empty_default(self):
        for decision in ({"type": "alert", "accept": True}, {"type": "confirm", "accept": False}, {"type": "beforeunload", "accept": False},
                         {"type": "prompt", "accept": False}, {"type": "prompt", "accept": True, "message": ""}):
            result = {"type": decision["type"], "message": "", "defaultValue": "", "accepted": decision["accept"]}
            if decision["type"] == "prompt" and decision["accept"]:
                result["promptText"] = ""
            def exercise(client):
                self.assertEqual(client.arm_dialog(9, decision, timeout_ms=1000)["dialogId"], "original")
                self.assertEqual(client.collect_dialog(9, "original"), result)
                self.assertEqual(client.cancel_dialog(9, "original"), {})
            self.serve([
                ("getInfo", NOOP, INFO), ("getControlState", NOOP, self.state(7)),
                ("armDialog", NOOP, {"result": {"dialogId": "original", "remainingMs": 500}}),
                ("collectDialog", self.check_handle, {"result": result}), ("cancelDialog", self.check_handle, {"result": {}}),
            ], exercise)

    def test_invalid_schema_unicode_and_exact_capability_have_no_dialog_side_effects(self):
        client = OpenBrowserUseClient("unused")
        for value in (None, [], {}, {**DECISION, "type": "print"}, {**DECISION, "accept": "true"}, {**DECISION, "extra": 1},
                      {**DECISION, "message": "\ud800"}, {**DECISION, "promptText": "🙂" * 2049}, {"type": "confirm", "accept": True, "promptText": ""},
                      {"type": "prompt", "accept": False, "promptText": ""}):
            with self.assertRaises(ValueError):
                OpenBrowserUseBrowser(client).tab(9).expect_dialog(value)
        for changed in ({"tabId": True}, {"tabId": -1}, {"control_epoch": 0}, {"session_id": "\ud800"}, {"timeoutMs": None}, {"timeoutMs": True}, {"timeoutMs": 120001}, {"extra": 1}):
            with self.assertRaises(ValueError):
                client.request("armDialog", {"tabId": 9, **DECISION, **changed})
        for identifier in (None, "", 1, "界" * 43, "\ud800"):
            with self.assertRaises(ValueError):
                client.collect_dialog(9, identifier)
        self.assertIsNone(client._socket)
        dialog_decision({"type": "prompt", "accept": True, "message": "🙂" * 2048, "promptText": ""})
        with self.assertRaises(ValueError):
            dialog_params("collectDialog", {"tabId": 9, "dialogId": "d", "timeoutMs": 1})
        def exercise(current):
            for method in ("armDialog", "collectDialog", "cancelDialog"):
                with self.assertRaisesRegex(RuntimeError, "OBU_DIALOG_UNSUPPORTED"):
                    current.request(method, {"tabId": 9, **(DECISION if method == "armDialog" else {"dialogId": "d"})})
        self.serve([("getInfo", NOOP, {"result": {"metadata": {"turnLifecycleVersion": 1, "dialogVersion": True}}}),
                    ("getControlState", NOOP, self.state(7))], exercise)

    def test_wire_results_and_original_decision_mismatch_are_rejected_without_rearm(self):
        for value in ({**RESULT, "accepted": "true"}, {**RESULT, "defaultValue": "\ud800"}, {**RESULT, "extra": 1},
                      {"type": "prompt", "message": "", "defaultValue": "", "accepted": True},
                      {"type": "confirm", "message": "", "defaultValue": "", "accepted": False, "promptText": ""}):
            with self.assertRaisesRegex(RuntimeError, "Invalid native dialog result"):
                dialog_result(value)
        def exercise(client):
            wait = OpenBrowserUseBrowser(client).tab(9).expect_dialog(DECISION)
            with self.assertRaisesRegex(RuntimeError, "Invalid native dialog result"):
                wait.result()
            with self.assertRaisesRegex(RuntimeError, "differs from original decision"):
                wait.result()
            with self.assertRaisesRegex(RuntimeError, "cancellation"):
                wait.cancel()
            wait.cancel()
        self.serve([
            ("getInfo", NOOP, INFO), ("getControlState", NOOP, self.state(7)),
            ("armDialog", NOOP, {"result": {"dialogId": "original", "remainingMs": 1000}}),
            ("collectDialog", self.check_handle, {"result": {**RESULT, "accepted": 1}}),
            ("collectDialog", self.check_handle, {"result": {**RESULT, "promptText": "changed"}}),
            ("cancelDialog", self.check_handle, {"result": {"ok": True}}), ("cancelDialog", self.check_handle, {"result": {}}),
        ], exercise)
        for remaining in (True, 0, -1, 1001, float("nan"), float("inf")):
            with self.assertRaises(RuntimeError):
                dialog_ack({"dialogId": "d", "remainingMs": remaining}, 1000)

    def test_expiry_sends_no_collect_and_cancellation_retains_scope(self):
        def exercise(client):
            wait = OpenBrowserUseBrowser(client).tab(9).expect_dialog(DECISION)
            time.sleep(.03)
            with self.assertRaisesRegex(TimeoutError, "deadline expired"):
                wait.result()
            wait.cancel()
            wait.cancel()
        self.serve([
            ("getInfo", NOOP, INFO), ("getControlState", NOOP, self.state(7)),
            ("armDialog", NOOP, {"result": {"dialogId": "original", "remainingMs": 20}}),
            ("cancelDialog", self.check_handle, {"result": {}}), ("cancelDialog", self.check_handle, {"result": {}}),
        ], exercise)

    def test_concurrent_result_is_one_collection_and_close_is_terminal(self):
        entered, release = threading.Event(), threading.Event()
        def collect(params):
            self.check_handle(params)
            entered.set()
            self.assertTrue(release.wait(1))
        def exercise(client):
            wait = OpenBrowserUseBrowser(client).tab(9).expect_dialog(DECISION)
            values, errors = [], []
            def run():
                try:
                    values.append(wait.result())
                except BaseException as error:
                    errors.append(error)
            thread = threading.Thread(target=run)
            thread.start()
            self.assertTrue(entered.wait(1))
            try:
                with self.assertRaisesRegex(RuntimeError, "OBU_DIALOG_BUSY"):
                    wait.result()
            finally:
                release.set()
                thread.join(1)
            self.assertEqual(errors, [])
            self.assertEqual(values, [RESULT])
            client.close()
            with self.assertRaisesRegex(RuntimeError, "DISCONNECTED"):
                wait.cancel()
        self.serve([
            ("getInfo", NOOP, INFO), ("getControlState", NOOP, self.state(7)),
            ("armDialog", NOOP, {"result": {"dialogId": "original", "remainingMs": 1000}}),
            ("collectDialog", collect, {"result": RESULT}),
        ], exercise)

    def test_original_scope_survives_turn_end_and_does_not_silently_rearm(self):
        def exercise(client):
            wait = OpenBrowserUseBrowser(client).tab(9).expect_dialog(DECISION)
            client.turn_ended()
            with self.assertRaisesRegex(RuntimeError, "OBU_STALE_CONTROL_EPOCH"):
                wait.result()
            with self.assertRaisesRegex(RuntimeError, "OBU_STALE_CONTROL_EPOCH"):
                wait.cancel()
            self.assertEqual(client._control_epoch, 8)
        self.serve([
            ("getInfo", NOOP, INFO), ("getControlState", NOOP, self.state(7)),
            ("armDialog", NOOP, {"result": {"dialogId": "original", "remainingMs": 1000}}),
            ("turnEnded", NOOP, self.state(8)),
            ("collectDialog", self.check_handle, {"error": {"message": "OBU_STALE_CONTROL_EPOCH"}}),
            ("cancelDialog", self.check_handle, {"error": {"message": "OBU_STALE_CONTROL_EPOCH"}}),
        ], exercise)

    def test_setup_spends_original_budget_and_ack_cannot_expand_sent_timeout(self):
        def exercise(client):
            with self.assertRaisesRegex(RuntimeError, "acknowledgement"):
                OpenBrowserUseBrowser(client).tab(9).expect_dialog(DECISION, timeout_ms=1000)
        self.serve([
            ("getInfo", lambda p: time.sleep(.03), INFO), ("getControlState", NOOP, self.state(7)),
            ("armDialog", lambda p: self.assertLess(p["timeoutMs"], 1000), {"result": {"dialogId": "original", "remainingMs": 1000}}),
        ], exercise)

if __name__ == "__main__":
    unittest.main()
