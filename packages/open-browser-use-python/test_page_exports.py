import base64
import tempfile
import threading
import time
import unittest

import test_lifecycle as lifecycle
from test_transport_support import local_server
from open_browser_use import OpenBrowserUseBrowser, OpenBrowserUseClient
from open_browser_use.client import encode_frame, read_frame
from open_browser_use._page_exports import MAX_PAGE_EXPORT_BYTES, export_params, validate_export

INFO = {"result": {"metadata": {"turnLifecycleVersion": 1, "pageExportVersion": 1}}}


def result(format, data):
    return {"format": format, "mimeType": "application/pdf" if format == "pdf" else "multipart/related",
            "encoding": "base64", "data": base64.b64encode(data).decode("ascii"), "byteLength": len(data)}


class PageExportTest(unittest.TestCase):
    serve = lifecycle.ControlLifecycleTest.serve
    state = lifecycle.ControlLifecycleTest.state

    def test_helpers_scope_copy_and_binary_results(self):
        pdf_options = {"landscape": False, "marginTop": 0, "pageRanges": "1-2"}
        outputs = {"pdf": result("pdf", b"%PDF-\xff\0"), "mhtml": result("mhtml", "MIME-Version: 1.0\r\n报告🙂".encode())}

        def check(p):
            self.assertEqual((p["turn_id"], p["control_epoch"], p["tabId"]), ("initial", 7, 9))
            self.assertTrue(0 < p["timeoutMs"] <= 1000)
            if p["format"] == "pdf":
                self.assertEqual(p["pdf"], {"landscape": False, "marginTop": 0, "pageRanges": "1-2"})
            else:
                self.assertNotIn("pdf", p)

        def exercise(client):
            tab = OpenBrowserUseBrowser(client).tab(9)
            self.assertEqual(tab.export_pdf(pdf=pdf_options, timeout_ms=1000), outputs["pdf"])
            self.assertEqual(tab.export_mhtml(timeout_ms=1000), outputs["mhtml"])
            self.assertEqual(tab.export_page("mhtml", timeout_ms=1000), outputs["mhtml"])

        self.serve([("getInfo", lambda p: pdf_options.update(pageRanges="9"), INFO),
                    ("getControlState", lambda p: None, self.state(7)),
                    ("exportPage", check, {"result": outputs["pdf"]}),
                    ("exportPage", check, {"result": outputs["mhtml"]}),
                    ("exportPage", check, {"result": outputs["mhtml"]})], exercise)

    def test_options_reject_without_connecting(self):
        client = OpenBrowserUseClient("unused")
        tab = OpenBrowserUseBrowser(client).tab(9)
        for options in ({"max_bytes": 0}, {"max_bytes": MAX_PAGE_EXPORT_BYTES + 1}, {"max_bytes": True}, {"max_bytes": 1.5},
                        {"timeout_ms": 0}, {"timeout_ms": 1.5}, {"timeout_ms": 120001}, {"timeout_ms": True}):
            with self.subTest(options=options), self.assertRaises(ValueError):
                tab.export_pdf(**options)
        for pdf in ([], {"path": "x"}, {"landscape": 1}, {"scale": .09}, {"scale": 2.1}, {"scale": float("nan")},
                    {"paperWidth": 0}, {"paperHeight": 201}, {"marginLeft": -1}, {"marginRight": 201},
                    {"pageRanges": "all"}, {"pageRanges": "1\n"}, {"pageRanges": "1" * 1025}):
            with self.subTest(pdf=pdf), self.assertRaises(ValueError):
                tab.export_pdf(pdf=pdf)
        with self.assertRaises(ValueError):
            tab.export_page("mhtml", pdf={})
        with self.assertRaises(ValueError):
            tab.export_page("png")
        with self.assertRaises(TypeError):
            tab.export_pdf(path="x")
        self.assertIsNone(client._socket)
        self.assertEqual(export_params("pdf", 1, 1, {"scale": .1, "paperWidth": 200, "marginLeft": 200})["maxBytes"], 1)

    def test_exact_result_schema_canonical_encoding_and_cap(self):
        good = result("pdf", b"\xff")
        for value in (None, {}, {**good, "extra": 1}, {**good, "format": "mhtml"}, {**good, "mimeType": "text/html"},
                      {**good, "encoding": "utf8"}, {**good, "data": "/x=="}, {**good, "data": "_w=="},
                      {**good, "data": "/w=\n"}, {**good, "data": "????"}, {**good, "byteLength": True},
                      {**good, "byteLength": 2}, {**good, "byteLength": 0}):
            with self.subTest(value=value), self.assertRaisesRegex(RuntimeError, "Invalid exportPage"):
                validate_export(value, "pdf", 100)
        with self.assertRaises(RuntimeError):
            validate_export(result("mhtml", "中文".encode()), "mhtml", 5)
        boundary = result("pdf", b"\xff" * MAX_PAGE_EXPORT_BYTES)
        self.assertEqual(validate_export(boundary, "pdf", MAX_PAGE_EXPORT_BYTES)["byteLength"], MAX_PAGE_EXPORT_BYTES)
        with self.assertRaises(RuntimeError):
            validate_export(boundary, "pdf", MAX_PAGE_EXPORT_BYTES - 1)

    def test_capability_gate_also_applies_to_manual_epoch(self):
        for version in (None, True, 2):
            for manual in (False, True):
                def exercise(client):
                    with self.assertRaisesRegex(RuntimeError, "OBU_PAGE_EXPORT_UNSUPPORTED"):
                        if manual:
                            client.request("exportPage", {"tabId": 9, "format": "pdf", "control_epoch": 7})
                        else:
                            OpenBrowserUseBrowser(client).tab(9).export_pdf()
                exchanges = [("getInfo", lambda p: None, {"result": {"metadata": {"turnLifecycleVersion": 1, "pageExportVersion": version}}})]
                if not manual:
                    exchanges.append(("getControlState", lambda p: None, self.state(7)))
                self.serve(exchanges, exercise)

    def test_short_budget_includes_discovery(self):
        for manual in (False, True):
            def exercise(client):
                client.timeout = 10
                with self.assertRaisesRegex(TimeoutError, "deadline"):
                    if manual:
                        client.request("exportPage", {"tabId": 9, "format": "pdf", "control_epoch": 7, "timeoutMs": 20})
                    else:
                        OpenBrowserUseBrowser(client).tab(9).export_pdf(timeout_ms=20)
            exchanges = [("getInfo", lambda p: time.sleep(.15), INFO)]
            if not manual:
                exchanges.append(("getControlState", lambda p: None, self.state(7)))
            self.serve(exchanges, exercise)

    def test_raw_deadline_is_strict(self):
        def exercise(client):
            for value in (None, True, 0, 1.5, 120001):
                with self.assertRaisesRegex(ValueError, "timeout"):
                    client.request("exportPage", {"tabId": 9, "format": "pdf", "timeoutMs": value})
        self.serve([("getInfo", lambda p: None, INFO), ("getControlState", lambda p: None, self.state(7))], exercise)

    def test_export_keeps_scope_captured_before_bootstrap(self):
        reference = {}
        def advance_client(p):
            reference["client"].turn_id = "later"
        def check(p):
            self.assertEqual(p["turn_id"], "initial")
            self.assertEqual(p["control_epoch"], 7)
        def exercise(client):
            reference["client"] = client
            with self.assertRaisesRegex(RuntimeError, "OBU_STALE_CONTROL_EPOCH"):
                OpenBrowserUseBrowser(client).tab(9).export_pdf()
        self.serve([("getInfo", advance_client, INFO), ("getControlState", lambda p: None, self.state(7)),
                    ("exportPage", check, {"error": {"message": "OBU_STALE_CONTROL_EPOCH"}})], exercise)

    def test_lost_reply_is_not_replayed(self):
        errors, seen = [], []
        with tempfile.TemporaryDirectory() as directory:
            endpoint, listener = local_server(directory)
            def server():
                try:
                    conn, _ = listener.accept()
                    with conn:
                        for response in (INFO, self.state(7)):
                            req = read_frame(conn); seen.append(req["method"])
                            conn.sendall(encode_frame({"id": req["id"], **response}))
                        req = read_frame(conn); seen.append(req["method"])
                        # Close after receipt without an acknowledgement.
                except BaseException as error:
                    errors.append(error)
                finally:
                    listener.close()
            thread = threading.Thread(target=server, daemon=True); thread.start()
            client = OpenBrowserUseClient(endpoint, turn_id="initial")
            try:
                with self.assertRaises((RuntimeError, EOFError, OSError)):
                    OpenBrowserUseBrowser(client).tab(9).export_pdf(timeout_ms=50)
            finally:
                client.close()
            thread.join(2); self.assertFalse(thread.is_alive())
            if errors: raise errors[0]
        self.assertEqual(seen, ["getInfo", "getControlState", "exportPage"])
