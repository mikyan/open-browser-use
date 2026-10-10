import base64
import time
import unittest
from unittest.mock import patch
import test_lifecycle as lifecycle
from open_browser_use import OpenBrowserUseBrowser, OpenBrowserUseClient
from open_browser_use._clipboard import MAX_CLIPBOARD_BYTES, clipboard_params, validate_clipboard_items, validate_clipboard_result

INFO = {"result": {"metadata": {"turnLifecycleVersion": 1, "clipboardVersion": 1}}}
PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII="


def rich():
    return [{"entries": [{"mime_type": "text/plain", "text": "中文🙂"}, {"mime_type": "text/html", "text": "<b>报告</b>"}, {"mime_type": "image/png", "base64": PNG}], "presentation_style": "inline"}]


class ClipboardEncodedBoundsTests(unittest.TestCase):
    def test_escaped_request_and_result_limits_before_transport(self):
        client = OpenBrowserUseClient(socket_path="unused")
        clipboard = OpenBrowserUseBrowser(client).tab(9).clipboard
        with patch.object(client, "request", side_effect=AssertionError("overflow must not reach transport")):
            for character in ("<", "\x00"):
                text = character * (8 * 1024 * 1024)
                items = [{"entries": [{"mime_type": "text/plain", "text": text}]}]
                with self.assertRaisesRegex(ValueError, "OBU_CLIPBOARD_LIMIT"):
                    clipboard.write_text(text)
                with self.assertRaisesRegex(ValueError, "OBU_CLIPBOARD_LIMIT"):
                    clipboard.write(items)
                for method, value in (("readClipboardText", {"text": text}), ("readClipboard", {"items": items})):
                    with self.assertRaisesRegex(ValueError, "OBU_CLIPBOARD_LIMIT"):
                        validate_clipboard_result(method, value, MAX_CLIPBOARD_BYTES)
        boundary = "<" * ((48 * 1024 * 1024 - 11) // 6)
        self.assertEqual(validate_clipboard_result("readClipboardText", {"text": boundary}, MAX_CLIPBOARD_BYTES)["text"], boundary)
        with self.assertRaisesRegex(ValueError, "OBU_CLIPBOARD_LIMIT"):
            validate_clipboard_result("readClipboardText", {"text": boundary + "<"}, MAX_CLIPBOARD_BYTES)


class ClipboardTest(unittest.TestCase):
    serve = lifecycle.ControlLifecycleTest.serve
    state = lifecycle.ControlLifecycleTest.state

    def test_facade_envelopes_scope_and_mutation_copy(self):
        items = rich()
        def check(p):
            self.assertEqual((p["tabId"], p["turn_id"], p["control_epoch"]), (9, "initial", 7))
            self.assertTrue(0 < p["timeoutMs"] <= 1000)
            self.assertEqual(p["maxBytes"], MAX_CLIPBOARD_BYTES)
            if p.get("items"):
                self.assertEqual(p["items"], rich())
        def exercise(client):
            clipboard = OpenBrowserUseBrowser(client).tab(9).clipboard
            self.assertIsNone(clipboard.write(items, timeout_ms=1000))
            self.assertEqual(clipboard.read(timeout_ms=1000), rich())
            self.assertEqual(clipboard.read_text(timeout_ms=1000), "中文🙂")
            self.assertIsNone(clipboard.write_text("", timeout_ms=1000))
            self.assertEqual(client.write_clipboard(9, [], timeout_ms=1000), {})
            self.assertEqual(client.read_clipboard_text(9, timeout_ms=1000), {"text": ""})
        self.serve([("getInfo", lambda p: items[0]["entries"][0].update(text="changed"), INFO),
                    ("getControlState", lambda p: None, self.state(7)),
                    ("writeClipboard", check, {"result": {}}), ("readClipboard", check, {"result": {"items": rich()}}),
                    ("readClipboardText", check, {"result": {"text": "中文🙂"}}), ("writeClipboardText", check, {"result": {}}),
                    ("writeClipboard", check, {"result": {}}), ("readClipboardText", check, {"result": {"text": ""}})], exercise)

    def test_invalid_options_and_payload_before_connect(self):
        client = OpenBrowserUseClient("unused")
        clipboard = OpenBrowserUseBrowser(client).tab(9).clipboard
        for options in ({"max_bytes": 0}, {"max_bytes": MAX_CLIPBOARD_BYTES+1}, {"max_bytes": True}, {"timeout_ms": .5}, {"timeout_ms": True}, {"timeout_ms": 0}, {"timeout_ms": 120001}):
            with self.subTest(options=options), self.assertRaises(ValueError):
                clipboard.write_text("x", **options)
        for text in (None, 1, "\ud800", "\udfff"):
            with self.subTest(text=repr(text)), self.assertRaises(ValueError):
                clipboard.write_text(text)
        for entries in ([], [{"mime_type": "text/plain"}], [{"mime_type": "text/plain", "text": "x", "base64": "eA=="}],
                        [{"mime_type": "text/plain", "text": "x", "extra": 1}], [{"mime_type": "image/jpeg", "base64": PNG}],
                        [{"mime_type": "image/png", "base64": PNG+"\n"}], [{"mime_type": "image/png", "base64": "eA=="}],
                        [{"mime_type": "text/plain", "text": "x"}]*2):
            with self.subTest(entries=entries), self.assertRaises(ValueError):
                clipboard.write([{"entries": entries}])
        for items in (None, {}, rich()*2, [{**rich()[0], "extra": 1}], [{**rich()[0], "presentation_style": None}]):
            with self.subTest(items=items), self.assertRaises(ValueError):
                clipboard.write(items)
        with self.assertRaises(TypeError):
            clipboard.read(extra=1)
        self.assertIsNone(client._socket)

    def test_exact_results_utf8_aggregate_bytes_and_png_preflight(self):
        for value in (None, {}, {"text": 1}, {"text": "\udfff"}, {"text": "x", "extra": 1}):
            with self.assertRaises(ValueError): validate_clipboard_result("readClipboardText", value, 100)
        for value in ({}, {"items": None}, {"items": [], "extra": 1}):
            with self.assertRaises(ValueError): validate_clipboard_result("readClipboard", value, 100)
        with self.assertRaises(ValueError): validate_clipboard_result("writeClipboard", {"ok": True}, 100)
        self.assertEqual(validate_clipboard_result("readClipboard", {"items": []}, 1), {"items": []})
        total = len("中文🙂<b>报告</b>".encode()) + len(base64.b64decode(PNG))
        self.assertEqual(validate_clipboard_items(rich(), total), rich())
        with self.assertRaises(ValueError): validate_clipboard_items(rich(), total-1)
        for offset, patch in ((16, b"\0\0\0\0"), (16, (16777217).to_bytes(4, "big")), (24, b"\x03"), (26, b"\x01"), (28, b"\x02")):
            data = bytearray(base64.b64decode(PNG)); data[offset:offset+len(patch)] = patch
            with self.assertRaises(ValueError): validate_clipboard_items([{"entries": [{"mime_type": "image/png", "base64": base64.b64encode(data).decode()}]}], 1000)
        boundary = "x" * MAX_CLIPBOARD_BYTES
        self.assertEqual(validate_clipboard_result("readClipboardText", {"text": boundary}, MAX_CLIPBOARD_BYTES)["text"], boundary)
        with self.assertRaises(ValueError): validate_clipboard_result("readClipboardText", {"text": boundary}, MAX_CLIPBOARD_BYTES-1)

    def test_capability_gate_including_manual_epochs(self):
        for version in (None, True, 2):
            for manual in (False, True):
                def exercise(client):
                    with self.assertRaisesRegex(RuntimeError, "OBU_CLIPBOARD_UNSUPPORTED"):
                        if manual: client.request("readClipboard", {"tabId": 9, "control_epoch": 7})
                        else: OpenBrowserUseBrowser(client).tab(9).clipboard.read()
                exchanges = [("getInfo", lambda p: None, {"result": {"metadata": {"turnLifecycleVersion": 1, "clipboardVersion": version}}})]
                if not manual: exchanges.append(("getControlState", lambda p: None, self.state(7)))
                self.serve(exchanges, exercise)

    def test_budget_consumes_discovery_without_late_write(self):
        def exercise(client):
            with self.assertRaises(TimeoutError):
                OpenBrowserUseBrowser(client).tab(9).clipboard.write_text("never", timeout_ms=20)
        self.serve([("getInfo", lambda p: time.sleep(.1), INFO), ("getControlState", lambda p: None, self.state(7))], exercise)

    def test_stale_write_scope_is_not_refreshed_or_replayed(self):
        def check(p):
            self.assertEqual((p["control_epoch"], p["turn_id"]), (7, "old"))
        def exercise(client):
            client._lifecycle_version, client._control_epoch, client.turn_id = 1, 8, "new"
            with self.assertRaisesRegex(RuntimeError, "OBU_STALE_CONTROL_EPOCH"):
                client.request("writeClipboardText", {"tabId": 9, "text": "once", "control_epoch": 7, "turn_id": "old"}, timeout=2)
        self.serve([("getInfo", lambda p: None, INFO), ("writeClipboardText", check, {"error": {"message": "OBU_STALE_CONTROL_EPOCH"}})], exercise)

    def test_invalid_wire_deadline(self):
        def exercise(client):
            for timeout in (None, 0, 1.5, True, 120001):
                with self.assertRaisesRegex(ValueError, "timeoutMs"):
                    client.request("writeClipboard", {"tabId": 9, "items": [], "timeoutMs": timeout, "control_epoch": 7})
        self.serve([("getInfo", lambda p: None, INFO)], exercise)

    def test_lost_native_response_does_not_repeat_a_write(self):
        class LostResponse:
            def __init__(self): self.sent, self.closed = [], False
            def settimeout(self, value): pass
            def sendall(self, value): self.sent.append(value)
            def recv(self, count): raise TimeoutError("lost response")
            def close(self): self.closed = True
        socket = LostResponse()
        client = OpenBrowserUseClient("unused")
        client._socket, client._lifecycle_version, client._clipboard_version = socket, 0, 1
        with self.assertRaisesRegex(TimeoutError, "lost response"):
            OpenBrowserUseBrowser(client).tab(9).clipboard.write_text("once", timeout_ms=20)
        self.assertEqual(len(socket.sent), 1)
        self.assertTrue(socket.closed)


if __name__ == "__main__":
    unittest.main()
