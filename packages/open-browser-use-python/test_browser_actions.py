import unittest

from open_browser_use.client import OpenBrowserUseBrowser, OpenBrowserUseClient


class RecordingClient(OpenBrowserUseClient):
    def __post_init__(self):
        super().__post_init__()
        self.calls = []

    def request(self, method, params=None, *, timeout=None):
        self.calls.append((method, params, timeout))
        return {"value": None, "engine": {"name": "playwright-crx", "version": "0.15.0", "playwrightVersion": "1.53.0"}}


class BrowserActionsTest(unittest.TestCase):
    def setUp(self):
        self.client = RecordingClient("unused")
        self.tab = OpenBrowserUseBrowser(self.client).tab(7)

    def test_immutable_semantic_locator_chain_reaches_engine(self):
        rows = self.tab.get_by_role("row").filter(has_text="Pending")
        rows.nth(1).get_by_role("button", name="Approve", exact=True).click(timeout_ms=25000)
        rows.count()
        first, second = self.client.calls
        self.assertEqual(first[0], "browserAction")
        self.assertEqual(first[1], {
            "tabId": 7, "action": "click", "locator": [
                {"kind": "role", "role": "row", "exact": False},
                {"kind": "filter", "hasText": "Pending"},
                {"kind": "nth", "index": 1},
                {"kind": "role", "role": "button", "name": "Approve", "exact": True},
            ], "args": {}, "timeoutMs": 25000,
        })
        self.assertEqual(first[2], 26)
        self.assertEqual(len(second[1]["locator"]), 2)
        self.assertEqual(second[1]["action"], "count")
        self.assertEqual(self.tab.playwright.engine_info["playwrightVersion"], "1.53.0")

    def test_frame_locator_and_python_screenshot_options(self):
        self.tab.playwright.frame_locator("iframe").get_by_label("Email").fill("a@example.test")
        self.tab.screenshot(full_page=True, omit_background=True)
        self.assertEqual(self.client.calls[0][1]["locator"], [
            {"kind": "frame", "selector": "iframe"},
            {"kind": "label", "value": "Email", "exact": False},
        ])
        self.assertEqual(self.client.calls[1][1]["args"], {"fullPage": True, "omitBackground": True})

    def test_navigation_snapshot_and_coordinate_actions_use_engine(self):
        self.tab.goto("https://example.test", wait_until="domcontentloaded", timeout=30)
        self.tab.dom_snapshot()
        self.tab.mouse.wheel(0, 200)
        self.tab.keyboard.press("ControlOrMeta+A")
        self.assertEqual([call[1]["action"] for call in self.client.calls], ["goto", "snapshot", "mouse.wheel", "keyboard.press"])
        self.assertEqual(self.client.calls[0][2], 31)

    def test_unbounded_or_invalid_timeout_rejected_before_send(self):
        for timeout in (0, -1, float("inf"), 120001):
            with self.subTest(timeout=timeout), self.assertRaises(ValueError):
                self.tab.get_by_text("Submit").click(timeout_ms=timeout)
        self.assertEqual(self.client.calls, [])


if __name__ == "__main__":
    unittest.main()
