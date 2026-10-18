import importlib.util
import io
import json
from pathlib import Path
import unittest
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location("helper", Path(__file__).with_name("managed-workflow-helper.py"))
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)


class HelperTests(unittest.TestCase):
    def test_bound_child_is_used_and_only_wait_observers_are_cancelled(self):
        calls = []
        download = SimpleNamespace(download_id="original", path=lambda **args: calls.append(("path", args)) or "C:\\downloads\\report.json")
        download_wait = SimpleNamespace(waiter_id="dw", remaining_ms=10000, result=lambda: download, cancel=lambda: calls.append("cancel-download-wait"))
        child = SimpleNamespace(id=9, dom_snapshot=lambda: calls.append("bound-child") or "original", expect_download=lambda **args: calls.append(("expect-download", args)) or download_wait)
        page_wait = SimpleNamespace(waiter_id="pw", remaining_ms=10000, result=lambda: child, cancel=lambda: calls.append("cancel-page-wait"))
        source = SimpleNamespace(id=8, expect_page=lambda **args: page_wait)
        browser = SimpleNamespace(client=SimpleNamespace(begin_turn=lambda: {"controlEpoch": 1}), connect=lambda: None,
                                  new_tab=lambda **args: calls.append(("create", args)) or source, close=lambda: calls.append("close"))
        value = helper.TypedHelper(lambda args: browser)
        operations = [("connect", {"socketPath": "original", "sessionId": "task", "timeoutMs": 15000}), ("create", {}),
                      ("expectPage", {"tabId": 8, "timeoutMs": 15000}), ("collectPage", {}), ("cancelPage", {}),
                      ("snapshot", {"tabId": 9}), ("expectDownload", {"tabId": 9, "timeoutMs": 15000}),
                      ("collectDownload", {}), ("downloadPath", {"timeoutMs": 10000}), ("cancelDownload", {}), ("close", {})]
        for index, (op, args) in enumerate(operations, 1):
            result = value.call({"id": index, "op": op, "args": args})
            self.assertTrue(result["ok"], result)
        self.assertIn(("create", {"background_window": True}), calls)
        self.assertIn("bound-child", calls)
        self.assertIn(("expect-download", {"timeout_ms": 15000, "require_path": True}), calls)
        self.assertIn("cancel-download-wait", calls)
        self.assertFalse(value.failed)

    def test_unknown_input_and_failure_never_resume_or_reconnect(self):
        value = helper.TypedHelper(lambda args: self.fail("No connection permitted"))
        self.assertFalse(value.call({"id": 1, "op": "evaluate", "args": {}})["ok"])
        self.assertFalse(value.call({"id": 2, "op": "connect", "args": {"socketPath": "p", "sessionId": "s", "timeoutMs": 10}})["ok"])
        self.assertTrue(value.call({"id": 3, "op": "close", "args": {}})["ok"])
        self.assertTrue(value.failed)

    def test_protocol_bounds_ids_nonfinite_and_incomplete_lines(self):
        for line in [b"x" * 65537, b'{"id":1}', b'{"id":1,"op":"close","args":{"bad":NaN}}\n', b'{"id":2,"op":"close","args":{}}\n', b'{"id":1,"id":1,"op":"close","args":{}}\n']:
            output = io.BytesIO()
            self.assertEqual(helper.serve(io.BytesIO(line), output), 1)
            self.assertFalse(json.loads(output.getvalue().splitlines()[0])["ok"])

    def test_eof_close_error_is_a_real_nonzero_outcome(self):
        def bad_close():
            raise RuntimeError("original close failed")
        value = helper.TypedHelper()
        value.browser = SimpleNamespace(close=bad_close)
        output = io.BytesIO()
        self.assertEqual(helper.serve(io.BytesIO(), output, value), 1)
        self.assertEqual(json.loads(output.getvalue())["error"]["message"], "original close failed")

    def test_explicit_close_exits_cleanly_without_extra_input(self):
        output = io.BytesIO()
        self.assertEqual(helper.serve(io.BytesIO(b'{"id":1,"op":"close","args":{}}\n'), output), 0)
        self.assertEqual(json.loads(output.getvalue()), {"id": 1, "ok": True, "result": None})


if __name__ == "__main__":
    unittest.main()
