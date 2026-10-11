import time
import unittest
from unittest.mock import patch

from open_browser_use.client import OpenBrowserUseBrowser, OpenBrowserUseClient
import test_background_window as background_fixture


class LocatorUploadTest(unittest.TestCase):
    serve = background_fixture.BackgroundWindowTest.serve
    state = background_fixture.BackgroundWindowTest.state
    handshake = background_fixture.BackgroundWindowTest.handshake

    @staticmethod
    def envelope(version=1):
        return {"result": {"value": None, "engine": {"name": "playwright-crx", "version": "1",
                "playwrightVersion": "1", "capabilities": {"locatorFileUpload": version}}}}

    def test_paths_clear_frame_ref_and_fresh_capability_bound_scope(self):
        paths = ["/tmp/中文.txt", r"C:\folder\b.bin", r"\\server\share\directory"]
        original = paths.copy()
        actions = []
        def check(params):
            actions.append(params)
            self.assertEqual((params["tabId"], params["turn_id"], params["control_epoch"]), (12, "initial", 7))
        def preflight(params):
            check(params)
            self.assertEqual(params["action"], "engineInfo")
            self.assertNotIn("locator", params)
            paths[0] = "/mutated"
        def exercise(client):
            tab = OpenBrowserUseBrowser(client).tab(12)
            tab.frame_locator("iframe").get_by_label("Files").set_input_files(paths, timeout_ms=500)
            tab.get_by_ref("capture-1", "e1").set_input_files([])
        self.serve(self.handshake() + [("browserAction", preflight, self.envelope()),
                ("browserAction", check, self.envelope()), ("browserAction", preflight, self.envelope()),
                ("browserAction", check, self.envelope())], exercise)
        self.assertEqual([p["action"] for p in actions], ["engineInfo", "setInputFiles"] * 2)
        self.assertEqual(actions[1]["args"], {"files": original})
        self.assertEqual(actions[3]["args"], {"files": []})
        self.assertEqual(actions[1]["locator"], [{"kind": "frame", "selector": "iframe"}, {"kind": "label", "value": "Files", "exact": False}])
        self.assertEqual(actions[3]["locator"], [{"kind": "ref", "captureId": "capture-1", "ref": "e1"}])

    def test_invalid_paths_and_timeout_fail_before_connect(self):
        client = OpenBrowserUseClient("unused")
        locator = OpenBrowserUseBrowser(client).tab(12).locator("input")
        for files in [None, "/a", {}, (), [1], [""], ["relative"], ["C:relative"], ["\\rooted"],
                      ["\\\\server"], ["/a\0b"], ["/\ud800"], ["/a"] * 1025,
                      ["/" + "界" * 43691], ["/" + "a" * 131071] * 65]:
            with self.subTest(files_type=type(files)):
                with self.assertRaises(ValueError):
                    locator.set_input_files(files)
        for timeout in [True, 0, 1.2, 120001]:
            with self.assertRaises(ValueError):
                locator.set_input_files([], timeout_ms=timeout)
        with self.assertRaises(ValueError):
            client.request("browserAction", {"action": "setInputFiles", "args": {"files": [], "force": True}})
        self.assertIsNone(client._socket)

    def test_unknown_or_malformed_capability_does_not_send_setter(self):
        for version in [None, 0, 2, True, "1"]:
            with self.subTest(version=version):
                def exercise(client):
                    with self.assertRaisesRegex(RuntimeError, "OBU_LOCATOR_FILE_UPLOAD_UNSUPPORTED"):
                        client.request("browserAction", {"tabId": 12, "control_epoch": 7,
                                       "action": "setInputFiles", "args": {"files": []}}, timeout=2)
                self.serve([("browserAction", lambda p: self.assertEqual(p["action"], "engineInfo"), self.envelope(version))], exercise)

    def test_late_capability_keeps_original_deadline_and_never_sends_setter(self):
        def delayed(params):
            self.assertEqual(params["action"], "engineInfo")
            time.sleep(0.06)
        def exercise(client):
            with self.assertRaises((TimeoutError, RuntimeError, OSError)):
                OpenBrowserUseBrowser(client).tab(12).locator("input").set_input_files(["/tmp/a"], timeout_ms=20)
        self.serve(self.handshake() + [("browserAction", delayed, self.envelope())], exercise)

    def test_captured_turn_and_original_upload_error_are_preserved(self):
        calls = []
        client = OpenBrowserUseClient("unused", turn_id="initial")
        client._lifecycle_version = 1
        client._control_epoch = 7
        original = RuntimeError("original upload failure")
        def wire(method, params, deadline, **kwargs):
            calls.append((params.copy(), deadline))
            if params["action"] == "engineInfo":
                client.turn_id, client._control_epoch = "new-turn", 8
                return self.envelope()["result"]
            raise original
        with patch.object(client, "_wire_request", side_effect=wire):
            with self.assertRaises(RuntimeError) as raised:
                OpenBrowserUseBrowser(client).tab(12).locator("input").set_input_files(["/tmp/a"])
        self.assertIs(raised.exception, original)
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[0][1], calls[1][1])
        self.assertEqual((calls[1][0]["turn_id"], calls[1][0]["control_epoch"]), ("initial", 7))
