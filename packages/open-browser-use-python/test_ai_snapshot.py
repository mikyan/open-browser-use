import copy
import unittest

from open_browser_use import AISnapshot, OpenBrowserUseBrowser, OpenBrowserUseClient, OpenBrowserUseLocator


def capture_result() -> AISnapshot:
    snapshot = '- button "Save 中文 [ref=e999]" [ref=e1]\n- button "Child" [ref=f1e2]'
    return {"captureId": "capture", "snapshot": snapshot, "refs": ["e1", "f1e2"],
            "stats": {"bytes": len(snapshot.encode("utf-8")), "nodes": 4, "refs": 2, "frames": 2}, "complete": True}


class RecordingClient(OpenBrowserUseClient):
    def __post_init__(self):
        super().__post_init__()
        self.calls = []
        self.result = capture_result()
        self.failure = None

    def request(self, method, params=None, *, timeout=None):
        self.calls.append((method, params, timeout))
        if self.failure:
            raise RuntimeError(self.failure)
        return {"value": self.result, "engine": {"name": "playwright-crx", "version": "0.15.0", "playwrightVersion": "1.53.0"}}


class AISnapshotTest(unittest.TestCase):
    def setUp(self):
        self.client = RecordingClient("unused")
        self.tab = OpenBrowserUseBrowser(self.client).tab(7)

    def test_budget_mapping_trusted_refs_and_ref_action(self):
        result = self.tab.playwright.snapshot_ai(max_bytes=1024, max_nodes=20, max_refs=10,
                                                  max_frames=3, max_depth=12, timeout_ms=3000)
        self.assertEqual(result, self.client.result)
        self.assertNotIn("e999", result["refs"])
        method, params, timeout = self.client.calls[0]
        self.assertEqual(method, "browserAction")
        self.assertEqual(params["action"], "snapshotAI")
        self.assertEqual(params["args"], {"maxBytes": 1024, "maxNodes": 20, "maxRefs": 10, "maxFrames": 3, "maxDepth": 12})
        self.assertEqual(params["timeoutMs"], 3000)
        self.assertEqual(timeout, 4)
        self.client.result = "Child"
        self.assertEqual(self.tab.playwright.get_by_ref(result["captureId"], "f1e2").inner_text(), "Child")
        self.assertEqual(self.client.calls[1][1]["locator"], [{"kind": "ref", "captureId": "capture", "ref": "f1e2"}])

    def test_invalid_budgets_never_send_or_fall_back(self):
        for name, maximum in {"max_bytes": 262144, "max_nodes": 5000, "max_refs": 2000, "max_frames": 32, "max_depth": 64}.items():
            for value in (0, -1, 1.5, True, maximum + 1, float("inf")):
                with self.subTest(name=name, value=value), self.assertRaises(ValueError):
                    self.tab.snapshot_ai(**{name: value})
        with self.assertRaises(TypeError):
            self.tab.snapshot_ai(mode="ai")
        self.assertEqual(self.client.calls, [])
        self.client.failure = "Unsupported browser action: snapshotAI"
        with self.assertRaisesRegex(RuntimeError, "Unsupported"):
            self.tab.snapshot_ai()
        self.assertEqual([call[1]["action"] for call in self.client.calls], ["snapshotAI"])

    def test_strict_response_and_requested_limits(self):
        original = capture_result()
        mutations = [
            {"complete": False}, {"complete": 1}, {"complete": None}, {"captureId": ""},
            {"captureId": "x" * 129}, {"refs": ["e1", "e1"]}, {"refs": ["e1\n", "f1e2"]},
            {"stats": {**original["stats"], "refs": 3}},
            {"stats": {**original["stats"], "bytes": len(original["snapshot"])}},
            {"stats": {**original["stats"], "nodes": True}},
            {"stats": {**original["stats"], "nodes": 1.5}},
            {"stats": {**original["stats"], "frames": 0}},
            {"stats": {key: value for key, value in original["stats"].items() if key != "bytes"}},
            {"stats": {**original["stats"], "extra": 0}}, {"extra": True},
        ]
        for mutation in mutations:
            self.client.result = {**copy.deepcopy(original), **mutation}
            with self.subTest(mutation=mutation), self.assertRaisesRegex(RuntimeError, "Invalid snapshotAI"):
                self.tab.snapshot_ai()
        self.client.result = original
        for name in ("max_bytes", "max_nodes", "max_refs", "max_frames"):
            with self.assertRaisesRegex(RuntimeError, "Invalid snapshotAI"):
                self.tab.snapshot_ai(**{name: 1})

    def test_ref_chaining_rejected_and_actions_are_not_replayed(self):
        ref = self.tab.get_by_ref("capture", "e1")
        for derive in (
            lambda: ref.locator("div"), lambda: ref.frame_locator("iframe"), lambda: ref.get_by_role("button"),
            lambda: ref.get_by_text("x"), lambda: ref.get_by_label("x"), lambda: ref.get_by_placeholder("x"),
            lambda: ref.get_by_alt_text("x"), lambda: ref.get_by_title("x"), lambda: ref.get_by_test_id("x"),
            lambda: ref.first, lambda: ref.last, lambda: ref.nth(0), lambda: ref.filter(has_text="x"),
            lambda: ref.get_by_ref("capture", "e2"), lambda: self.tab.locator("div").get_by_ref("capture", "e1"),
            lambda: OpenBrowserUseLocator(self.tab, [{"kind": "ref", "captureId": "capture", "ref": "e1"}, {"kind": "first"}]),
        ):
            with self.assertRaisesRegex(ValueError, "Ref locators"):
                derive()
        for token in ("e0", "f0e1", "e1\n", "aria-ref=e1", "e1 >> button", "e" + "1" * 64):
            with self.assertRaisesRegex(ValueError, "native snapshot"):
                self.tab.get_by_ref("capture", token)
        for capture_id in ("", "x" * 129):
            with self.assertRaisesRegex(ValueError, "capture_id"):
                self.tab.get_by_ref(capture_id, "e1")
        self.assertEqual(self.client.calls, [])
        ref.click()
        self.tab.locator("#source").drag_to(ref)
        self.assertEqual(self.client.calls[1][1]["args"]["target"], [{"kind": "ref", "captureId": "capture", "ref": "e1"}])
        self.client.result = {"base64": "AA==", "mimeType": "image/png"}
        self.assertEqual(ref.screenshot(), self.client.result)
        self.client.result = '- button "Save"'
        self.assertEqual(ref.aria_snapshot(), self.client.result)
        count = len(self.client.calls)
        self.client.failure = "OBU_CAPTURE_EXPIRED"
        with self.assertRaisesRegex(RuntimeError, "OBU_CAPTURE_EXPIRED"):
            ref.click()
        self.assertEqual(len(self.client.calls), count + 1)


if __name__ == "__main__":
    unittest.main()
