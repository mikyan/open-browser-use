import time
import unittest

import test_lifecycle as lifecycle
from open_browser_use import OpenBrowserUseBrowser, OpenBrowserUseClient, OpenBrowserUseDownload
from open_browser_use._downloads import download_id

INFO = {"result": {"metadata": {"turnLifecycleVersion": 1, "directDownloadsVersion": 1}}}


class DownloadTest(unittest.TestCase):
    serve = lifecycle.ControlLifecycleTest.serve
    state = lifecycle.ControlLifecycleTest.state

    def test_path_retry_cancel_and_bound_scope(self):
        for source in ("downloadURL", "waitForDownload"):
            def check(p):
                self.assertEqual((p["turn_id"], p["control_epoch"]), ("initial", 7))
                self.assertTrue(0 < p["timeoutMs"] <= 1000)

            def start(p):
                check(p)
                if source == "downloadURL":
                    self.assertEqual(p["filename"], "报告.csv")
                    self.assertEqual(p["url"], "https://fixture.test/file")

            def exercise(client):
                tab = OpenBrowserUseBrowser(client).tab(9)
                item = (tab.download_url("https://fixture.test/file", filename="报告.csv", timeout_ms=1000)
                        if source == "downloadURL" else tab.wait_for_download(timeout_ms=1000))
                self.assertEqual(item.download_id, "opaque")
                with self.assertRaisesRegex(RuntimeError, "OBU_DOWNLOAD_TIMEOUT"):
                    item.path(timeout_ms=1000)
                self.assertEqual(item.path(timeout_ms=1000), "C:\\Downloads\\报告.csv")
                self.assertIsNone(item.cancel(timeout_ms=1000))
                client.begin_turn()
                with self.assertRaisesRegex(RuntimeError, "OBU_STALE_CONTROL_EPOCH"):
                    item.path(timeout_ms=1000)
                with self.assertRaisesRegex(RuntimeError, "OBU_STALE_CONTROL_EPOCH"):
                    item.cancel(timeout_ms=1000)

            self.serve([
                ("getInfo", lambda p: None, INFO), ("getControlState", lambda p: None, self.state(7)),
                (source, start, {"result": {"downloadId": "opaque"}}),
                ("downloadPath", check, {"error": {"message": "OBU_DOWNLOAD_TIMEOUT"}}),
                ("downloadPath", check, {"result": {"path": "C:\\Downloads\\报告.csv"}}),
                ("cancelDownload", check, {"result": {"cancelled": True}}),
                ("getControlState", lambda p: None, self.state(8)),
                ("downloadPath", check, {"error": {"message": "OBU_STALE_CONTROL_EPOCH"}}),
                ("cancelDownload", check, {"error": {"message": "OBU_STALE_CONTROL_EPOCH"}}),
            ], exercise)

    def test_short_budget_includes_discovery(self):
        for raw in (False, True):
            def exercise(client):
                client.timeout = 10
                with self.assertRaisesRegex(TimeoutError, "deadline"):
                    if raw:
                        client.request("downloadURL", {"tabId": 9, "url": "https://fixture.test/", "timeoutMs": 100})
                    else:
                        OpenBrowserUseBrowser(client).tab(9).download_url("https://fixture.test/", timeout_ms=100)
            self.serve([("getInfo", lambda p: time.sleep(.25), INFO),
                        ("getControlState", lambda p: None, self.state(7))], exercise)

    def test_invalid_inputs_unsupported_and_results(self):
        client = OpenBrowserUseClient("unused")
        tab = OpenBrowserUseBrowser(client).tab(9)
        for url in ("", "file:///tmp/x", "data:text/plain,a", "https://user:secret@fixture.test/", "https://fixture.test/\n", "https://fixture.test/" + "🙂" * 2048):
            with self.assertRaises(ValueError):
                tab.download_url(url)
        for filename in ("", "..", "../a", "CON.txt", "a/b", "a\\b", "a.", "a ", "a\0", "🙂" * 64):
            with self.assertRaises(ValueError):
                tab.download_url("https://fixture.test/", filename=filename)
        for timeout in (0, -1, True, 1.5, 120001):
            with self.assertRaises(ValueError):
                tab.download_url("https://fixture.test/", timeout_ms=timeout)
        self.assertIsNone(client._socket)
        def exercise(c):
            with self.assertRaisesRegex(RuntimeError, "OBU_DIRECT_DOWNLOADS_UNSUPPORTED"):
                OpenBrowserUseBrowser(c).tab(9).download_url("https://fixture.test/")
        self.serve([("getInfo", lambda p: None, {"result": {"metadata": {"turnLifecycleVersion": 1, "directDownloadsVersion": True}}}),
                    ("getControlState", lambda p: None, self.state(7))], exercise)
        for ack in ({"downloadId": ""}, {"downloadId": 3}, {"downloadId": "d", "path": "x"}, None):
            with self.assertRaises(RuntimeError):
                download_id(ack)
        for ack in ({"path": ""}, {"path": "x\0"}, {"path": "x", "extra": 1}, {}, None):
            with self.assertRaises(RuntimeError):
                OpenBrowserUseDownload("d", lambda *args: ack).path()
        for ack in ({"cancelled": 1}, {"cancelled": False}, {"cancelled": True, "extra": 1}, {}, None):
            with self.assertRaises(RuntimeError):
                OpenBrowserUseDownload("d", lambda *args: ack).cancel()
