import time
import unittest

import test_lifecycle as lifecycle
from open_browser_use import OpenBrowserUseBrowser, OpenBrowserUseClient
from open_browser_use._browser_actions import OpenBrowserUseLocator


class MediaDownloadTest(unittest.TestCase):
    serve = lifecycle.ControlLifecycleTest.serve
    state = lifecycle.ControlLifecycleTest.state

    @staticmethod
    def info(version=1):
        return {"result": {"metadata": {"turnLifecycleVersion": 1, "mediaDownloadsVersion": version}}}

    def test_capability_is_independent_and_manual_scope_still_negotiates(self):
        for manual in (False, True):
            for version in (False, True, 0, 2, "1", None):
                with self.subTest(manual=manual, version=version):
                    def exercise(client):
                        with self.assertRaisesRegex(RuntimeError, "OBU_MEDIA_DOWNLOADS_UNSUPPORTED"):
                            if manual:
                                client.request("downloadMedia", {"tabId": 9, "locator": [{"kind": "css", "selector": "img"}],
                                               "session_id": "manual", "turn_id": "manual-turn", "control_epoch": 19})
                            else:
                                OpenBrowserUseBrowser(client).tab(9).locator("img").download_media()
                        client.request("ping")  # Any replay or unexpected download fails the next wire-method check.

                    exchanges = [("getInfo", lambda p: None, self.info(version))]
                    if not manual:
                        exchanges.append(("getControlState", lambda p: None, self.state(7)))
                        if version is None:
                            exchanges.append(("getInfo", lambda p: None, self.info(version)))
                    self.serve(exchanges + [("ping", lambda p: None, {"result": {}})], exercise)

        def original_scope(params):
            self.assertEqual((params["session_id"], params["turn_id"], params["control_epoch"]), ("manual", "manual-turn", 19))
            self.assertEqual(params["locator"], [{"kind": "css", "selector": "img"}])
            self.assertNotIn("url", params)

        self.serve([("getInfo", lambda p: None, self.info()),
                    ("downloadMedia", original_scope, {"result": {"downloadId": "media"}})],
                   lambda client: client.request("downloadMedia", {"tabId": 9, "locator": [{"kind": "css", "selector": "img"}],
                       "session_id": "manual", "turn_id": "manual-turn", "control_epoch": 19}, timeout=2))

    def test_invalid_options_and_url_injection_fail_before_connection(self):
        client = OpenBrowserUseClient("unused")
        tab = OpenBrowserUseBrowser(client).tab(9)
        for filename in ("", "../x", "CON.png", "a\\b", "a.", "a ", "a\0", "🙂" * 64):
            with self.subTest(filename=filename), self.assertRaises(ValueError):
                tab.locator("img").download_media(filename=filename)
        for timeout in (0, -1, True, 1.5, 120001):
            with self.subTest(timeout=timeout), self.assertRaises(ValueError):
                tab.locator("img").download_media(timeout_ms=timeout)
        for options in ({"url": "https://poison.test/"}, {"method": "POST"}, {"saveAs": True}):
            with self.subTest(options=options), self.assertRaises(TypeError):
                tab.locator("img").download_media(**options)
        with self.assertRaisesRegex(ValueError, "nonempty locator"):
            OpenBrowserUseLocator(tab, []).download_media()
        self.assertIsNone(client._socket)

    def test_original_short_deadline_prevents_media_rpc_after_slow_discovery(self):
        for raw in (False, True):
            def exercise(client):
                client.timeout = 10
                with self.assertRaisesRegex(TimeoutError, "deadline"):
                    if raw:
                        client.request("downloadMedia", {"tabId": 9, "locator": [{"kind": "css", "selector": "img"}], "timeoutMs": 100})
                    else:
                        OpenBrowserUseBrowser(client).tab(9).locator("img").download_media(timeout_ms=100)
                client.request("ping")
            self.serve([("getInfo", lambda p: time.sleep(.25), self.info()),
                        ("getControlState", lambda p: None, self.state(7)),
                        ("ping", lambda p: None, {"result": {}})], exercise)

    def test_media_error_is_not_replayed_or_rebound(self):
        for message in ("OBU_DOWNLOAD_TIMEOUT", "OBU_STALE_CONTROL_EPOCH", "OBU_MEDIA_SOURCE_UNSUPPORTED"):
            def original(params):
                self.assertEqual((params["turn_id"], params["control_epoch"]), ("initial", 7))
                self.assertEqual(params["locator"], [{"kind": "frame", "selector": "#child"}, {"kind": "css", "selector": "img"}])
                self.assertNotIn("url", params)
            def exercise(client):
                with self.assertRaisesRegex(RuntimeError, message):
                    OpenBrowserUseBrowser(client).tab(9).frame_locator("#child").locator("img").download_media(timeout_ms=1000)
                self.assertEqual((client.turn_id, client._control_epoch), ("initial", 7))
                client.request("ping")
            self.serve([("getInfo", lambda p: None, self.info()),
                        ("getControlState", lambda p: None, self.state(7)),
                        ("downloadMedia", original, {"error": {"message": message}}),
                        ("ping", lambda p: None, {"result": {}})], exercise)
