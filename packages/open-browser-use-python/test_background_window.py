import tempfile
import threading
import time
import unittest

from open_browser_use.client import OpenBrowserUseClient, OpenBrowserUseCdp, OpenBrowserUseBrowser, encode_frame, read_frame
from test_transport_support import local_server


class BackgroundWindowTest(unittest.TestCase):
    def serve(self, exchanges, exercise, *, allow_late_disconnect=False):
        errors = []
        with tempfile.TemporaryDirectory() as directory:
            endpoint, listener = local_server(directory)

            def server():
                try:
                    conn, _ = listener.accept()
                    with conn:
                        for method, check, result in exchanges:
                            message = read_frame(conn)
                            self.assertEqual(message["method"], method)
                            check(message["params"])
                            conn.sendall(encode_frame({"id": message["id"], **result}))
                except BrokenPipeError as error:
                    if not allow_late_disconnect:
                        errors.append(error)
                except BaseException as error:
                    errors.append(error)
                finally:
                    listener.close()

            thread = threading.Thread(target=server, daemon=True)
            thread.start()
            client = OpenBrowserUseClient(endpoint, turn_id="initial", timeout=1)
            try:
                exercise(client)
            finally:
                client.close()
            thread.join(timeout=2)
            self.assertFalse(thread.is_alive(), "mock transport did not finish")
            if errors:
                raise errors[0]

    def state(self, epoch, turn="next", **extra):
        return {"result": {"lifecycleVersion": 1, "controlEpoch": epoch, "nextTurnId": turn, **extra}}

    def test_default_false_and_none_preserve_wire(self):
        def check(params):
            self.assertNotIn("backgroundWindow", params)
            self.assertEqual(params["control_epoch"], 7)
        def exercise(client):
            client.create_tab()
            client.create_tab(False)
            client.create_tab(None)
            OpenBrowserUseBrowser(client).new_tab(background_window=False)
        self.serve(self.handshake() + [("createTab", check, {"result": {"id": 12}})] * 4, exercise)

    def handshake(self):
        return [("getInfo", lambda p: None, {"result": {"metadata": {"turnLifecycleVersion": 1, "backgroundWindowVersion": 1}}}),
                ("getControlState", lambda p: None, self.state(7))]

    def test_true_navigation_and_fresh_capability(self):
        def create(params):
            self.assertEqual(params["backgroundWindow"], True)
            self.assertEqual((params["turn_id"], params["control_epoch"]), ("initial", 7))
        def navigate(params):
            self.assertNotIn("backgroundWindow", params)
            self.assertEqual((params["turn_id"], params["control_epoch"]), ("initial", 7))
        supported = ("getInfo", lambda p: None, {"result": {"metadata": {"backgroundWindowVersion": 1}}})
        def exercise(client):
            client.create_tab(True)
            OpenBrowserUseBrowser(client).new_tab(url="https://fixture.test", background_window=True)
            with self.assertRaisesRegex(RuntimeError, "OBU_BACKGROUND_WINDOW_UNSUPPORTED"):
                client.create_tab(True)
        self.serve(self.handshake() + [supported, ("createTab", create, {"result": {"id": 12}}),
                   supported, ("createTab", create, {"result": {"id": 12}}),
                   ("browserAction", navigate, {"result": {"value": None, "engine": {"name": "playwright-crx"}}}),
                   ("getInfo", lambda p: None, {"result": {"metadata": {}}})], exercise)

    def test_bad_capability_rejected_even_with_explicit_scope(self):
        for value in [None, 0, 2, True, "1", {}]:
            with self.subTest(value=value):
                def exercise(client):
                    with self.assertRaisesRegex(RuntimeError, "OBU_BACKGROUND_WINDOW_UNSUPPORTED"):
                        client.request("createTab", {"backgroundWindow": True, "control_epoch": 7})
                self.serve([("getInfo", lambda p: None, {"result": {"metadata": {"backgroundWindowVersion": value}}})], exercise)

    def test_invalid_options_fail_without_connecting(self):
        client = OpenBrowserUseClient("unused")
        for value in [0, 1, "true", [], {}]:
            with self.subTest(value=value):
                with self.assertRaisesRegex(ValueError, "boolean"):
                    client.create_tab(value)
                with self.assertRaisesRegex(ValueError, "boolean"):
                    OpenBrowserUseBrowser(client).new_tab(background_window=value)
                with self.assertRaisesRegex(ValueError, "boolean"):
                    client.request("createTab", {"backgroundWindow": value})
        with self.assertRaisesRegex(ValueError, "boolean"):
            client.request("createTab", {"backgroundWindow": None})
        self.assertIsNone(client._socket)

    def test_creation_failure_does_not_start_navigation_or_replay(self):
        def exercise(client):
            with self.assertRaisesRegex(RuntimeError, "creation failed"):
                OpenBrowserUseBrowser(client).new_tab(url="https://fixture.test", background_window=True)
        self.serve(self.handshake() + [
            ("getInfo", lambda p: None, {"result": {"metadata": {"backgroundWindowVersion": 1}}}),
            ("createTab", lambda p: None, {"error": {"message": "creation failed"}})], exercise)

    def test_late_capability_does_not_send_create(self):
        def delayed(params):
            time.sleep(0.08)
        def exercise(client):
            with self.assertRaises((TimeoutError, RuntimeError, OSError)):
                client.request("createTab", {"backgroundWindow": True, "control_epoch": 7}, timeout=0.02)
        # The only expected exchange is getInfo; no create may follow its late reply.
        self.serve([("getInfo", delayed, {"result": {"metadata": {"backgroundWindowVersion": 1}}})], exercise, allow_late_disconnect=True)
