import copy
import unittest

from open_browser_use import AISnapshotGeometry, OpenBrowserUseBrowser
from test_ai_snapshot import RecordingClient, capture_result


def geometry_result():
    result = capture_result()
    result["snapshot"] += " [box=0,-20,0,0]"
    result["stats"]["bytes"] = len(result["snapshot"].encode("utf-8"))
    result["geometry"] = {
        "coordinateSpace": "frame-viewport-css",
        "frames": [
            {"id": "root", "parentId": None, "ownerRef": None, "viewport": {"width": 800, "height": 600, "scrollX": -1.25, "scrollY": 100, "devicePixelRatio": 1.5}},
            {"id": "f1", "parentId": "root", "ownerRef": "e1", "viewport": {"width": 100, "height": 50, "scrollX": 0, "scrollY": 20, "devicePixelRatio": 1.5}},
        ],
        "boxes": [
            {"ref": "e1", "frameId": "root", "box": {"x": -1.5, "y": 2, "width": 100, "height": 50}},
            {"ref": "f1e2", "frameId": "f1", "box": {"x": 0, "y": -20, "width": 0, "height": 0}},
        ],
    }
    return result


def change(value, path, item):
    for key in path[:-1]:
        value = value[key]
    value[path[-1]] = item


class AISnapshotGeometryTest(unittest.TestCase):
    def setUp(self):
        self.client = RecordingClient("unused")
        self.tab = OpenBrowserUseBrowser(self.client).tab(7)
        self.client.result = geometry_result()

    def test_typed_options_native_identity_and_frame_local_geometry(self):
        result = self.tab.playwright.snapshot_ai(boxes=True, max_frames=2, timeout_ms=500)
        self.assertEqual(result, geometry_result())
        self.assertEqual(self.client.calls[0][1]["args"], {"boxes": True, "maxFrames": 2})
        self.assertEqual(self.client.calls[0][1]["timeoutMs"], 500)
        self.assertNotIn("e999", result["refs"])
        self.client.result = "original node"
        self.assertEqual(self.tab.get_by_ref(result["captureId"], "f1e2").inner_text(), "original node")
        self.assertEqual(self.client.calls[1][1]["locator"], [{"kind": "ref", "captureId": "capture", "ref": "f1e2"}])

    def test_request_geometry_agreement_defaults_and_no_fallback(self):
        for invalid in (None, 0, 1, "true", {}, []):
            with self.subTest(invalid=invalid), self.assertRaisesRegex(ValueError, "boolean"):
                self.tab.snapshot_ai(boxes=invalid)
        self.assertEqual(self.client.calls, [])
        for options in ({}, {"boxes": False}):
            with self.assertRaisesRegex(RuntimeError, "Invalid snapshotAI"):
                self.tab.snapshot_ai(**options)
        self.client.result = capture_result()
        with self.assertRaisesRegex(RuntimeError, "Invalid snapshotAI"):
            self.tab.snapshot_ai(boxes=True)
        self.assertEqual(self.tab.snapshot_ai(), capture_result())
        self.assertEqual(self.tab.snapshot_ai(boxes=False), capture_result())
        self.assertEqual(self.client.calls[-1][1]["args"], {})
        before = len(self.client.calls)
        self.client.failure = "unsupported boxes"
        with self.assertRaisesRegex(RuntimeError, "unsupported boxes"):
            self.tab.snapshot_ai(boxes=True)
        self.assertEqual(len(self.client.calls), before + 1)
        self.assertEqual(self.client.calls[-1][1]["args"], {"boxes": True})

    def test_strict_nested_geometry_numbers_and_frame_ownership(self):
        base = geometry_result()["geometry"]
        mutations = [
            (("geometry",), None),
            (("geometry", "coordinateSpace"), "main-viewport-css"),
            (("geometry", "frameGuid"), "private"),
            (("geometry", "boxes"), base["boxes"][:1]),
            (("geometry", "boxes", 1), base["boxes"][0]),
            (("geometry", "boxes", 1, "ref"), "e999"),
            (("geometry", "boxes", 1, "frameId"), "root"),
            (("geometry", "boxes", 1, "box"), None),
            (("geometry", "boxes", 1, "box", "width"), -1),
            (("geometry", "boxes", 0, "extra"), 1),
            (("geometry", "frames"), base["frames"][:1]),
            (("geometry", "frames"), list(reversed(base["frames"]))),
            (("geometry", "frames", 1), base["frames"][0]),
            (("geometry", "frames", 1, "id"), "f2"),
            (("geometry", "frames", 1, "id"), "f33"),
            (("geometry", "frames", 0, "ownerRef"), "e1"),
            (("geometry", "frames", 1, "parentId"), "f1"),
            (("geometry", "frames", 1, "parentId"), "f2"),
            (("geometry", "frames", 1, "ownerRef"), "f1e2"),
            (("geometry", "frames", 1, "ownerRef"), "e999"),
            (("geometry", "frames", 1, "frameGuid"), "private"),
            (("geometry", "frames", 0, "viewport", "devicePixelRatio"), 0),
            (("geometry", "frames", 0, "viewport", "height"), -1),
            (("geometry", "frames", 0, "viewport", "scale"), 1),
        ]
        for number in (True, None, "1", float("nan"), float("inf"), -float("inf"), 10 ** 1000):
            mutations.append((("geometry", "boxes", 0, "box", "x"), number))
            mutations.append((("geometry", "frames", 0, "viewport", "scrollY"), number))
        for path, value in mutations:
            self.client.result = geometry_result()
            change(self.client.result, path, copy.deepcopy(value))
            with self.subTest(path=path, value=value), self.assertRaisesRegex(RuntimeError, "Invalid snapshotAI"):
                self.tab.snapshot_ai(boxes=True)
        self.client.result = geometry_result()
        self.client.result["stats"]["frames"] = 3
        self.client.result["geometry"]["frames"].append({**base["frames"][1], "id": "f2"})
        with self.assertRaisesRegex(RuntimeError, "Invalid snapshotAI"):
            self.tab.snapshot_ai(boxes=True)
        self.client.result = geometry_result()
        del self.client.result["geometry"]["boxes"][1]["box"]["width"]
        with self.assertRaisesRegex(RuntimeError, "Invalid snapshotAI"):
            self.tab.snapshot_ai(boxes=True)

    def test_sparse_frame_slots_and_empty_root_observation(self):
        self.client.result["refs"][1] = "f32e2"
        self.client.result["geometry"]["boxes"][1]["ref"] = "f32e2"
        self.client.result["geometry"]["boxes"][1]["frameId"] = "f32"
        self.client.result["geometry"]["frames"][1]["id"] = "f32"
        self.assertEqual(self.tab.snapshot_ai(boxes=True)["geometry"]["frames"][1]["id"], "f32")
        with self.assertRaisesRegex(RuntimeError, "Invalid snapshotAI"):
            self.tab.snapshot_ai(boxes=True, max_bytes=1)
        self.client.result["refs"] = []
        self.client.result["stats"].update(refs=0, frames=1)
        self.client.result["geometry"]["boxes"] = []
        self.client.result["geometry"]["frames"] = self.client.result["geometry"]["frames"][:1]
        self.assertEqual(self.tab.snapshot_ai(boxes=True)["geometry"]["boxes"], [])


if __name__ == "__main__":
    unittest.main()
