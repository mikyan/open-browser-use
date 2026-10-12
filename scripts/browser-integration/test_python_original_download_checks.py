"""Helper-only checks over the platform's actual SDK IPC; no browser launch."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
from contextlib import chdir
import sys
import shutil
import tempfile
import threading
import time
import unittest

SDK = Path(__file__).resolve().parents[2] / "packages/open-browser-use-python"
sys.path.insert(0, str(SDK))
from open_browser_use.client import encode_frame, read_frame
from test_transport_support import local_server

spec = importlib.util.spec_from_file_location("original_download_helper", Path(__file__).with_name("python-original-download-checks.py"))
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)


class OriginalDownloadHelperTests(unittest.TestCase):
    def exercise(self, variant="root", kind="post", mode="", loaded_helper=None):
        with tempfile.TemporaryDirectory() as directory, tempfile.TemporaryDirectory(prefix="original-python-gate-", dir=SDK.parents[1] / ".tmp") as gate_directory:
            endpoint, listener = local_server(directory)
            gate = {"readyPath": str(Path(gate_directory) / "ready.json"), "releasePath": str(Path(gate_directory) / "release"), "token": "original-gate-token"}
            header = {"key": "original-key", "kind": kind, "owner": "original-owner", "nonce": "01234567-89ab-4cde-8fab-0123456789ab"}
            content = json.dumps(header).encode() + b"\n\x00\xff\xc3("
            digest = hashlib.sha256(content).hexdigest()
            path = Path(directory) / "original.bin"
            path.write_bytes(content)
            methods, actions, errors = [], [], []
            helper_done = threading.Event()

            def publish_gate():
                try:
                    end = time.monotonic() + 3
                    while not helper_done.is_set():
                        if time.monotonic() >= end:
                            self.fail("Helper never published readiness")
                        try:
                            ready = json.loads(Path(gate["readyPath"]).read_text(encoding="utf-8"))
                        except (FileNotFoundError, json.JSONDecodeError):
                            time.sleep(0.002)
                            continue
                        self.assertEqual(ready["token"], gate["token"])
                        self.assertEqual((ready["waiterId"], ready["tabId"]), ("original-waiter", 9))
                        self.assertEqual(ready["scope"], {"session_id": "owner-session", "turn_id": "original-turn", "control_epoch": 7})
                        if mode == "gate-timeout":
                            return
                        temporary = Path(gate_directory) / "release.tmp"
                        with temporary.open("xb") as output:
                            output.write(b"unknown-token" if mode == "gate-token" else gate["token"].encode())
                        os.replace(temporary, gate["releasePath"])
                        return
                except BaseException as error:
                    errors.append(error)

            def serve():
                try:
                    conn, _ = listener.accept()
                    with conn:
                        controls = clicks = adds = 0
                        while True:
                            try:
                                request = read_frame(conn)
                            except (EOFError, ConnectionError, BrokenPipeError):
                                break
                            method, params = request["method"], request["params"]
                            methods.append(method)
                            self.assertEqual((params["session_id"], params["turn_id"]), ("owner-session", "original-turn"))
                            if method not in {"getInfo", "getControlState"}:
                                self.assertEqual(params["control_epoch"], 7)
                            result, failure = {}, None
                            if method == "getInfo":
                                result = {"metadata": {"turnLifecycleVersion": 1, "downloadWaitVersion": 1, "downloadWaitPathVersion": 1, "directDownloadsVersion": 1}}
                            elif method == "getControlState":
                                controls += 1
                                result = {"lifecycleVersion": 1, "controlEpoch": 8 if mode == "changed-epoch" and controls == 3 else 7,
                                          "closing": False, "nextTurnId": "must-not-adopt"}
                            elif method == "armDownloadWait":
                                self.assertIs(params.get("requirePath"), True)
                                remaining = 100 if mode == "gate-timeout" else 500 if mode == "gate-add-late" else 14000
                                result = {"waiterId": "original-waiter", "remainingMs": remaining}
                            elif method == "collectDownloadWait":
                                result = {"downloadId": "original-native-guid"}
                            elif method == "downloadPath":
                                self.assertEqual((params["downloadId"], params["tabId"]), ("original-native-guid", 9))
                                result = {"path": str(path)}
                            elif method == "cancelDownloadWait":
                                if mode == "click-and-cleanup-fail":
                                    failure = "cleanup original failure"
                            elif method == "browserAction":
                                action, steps = params["action"], params["locator"]
                                value = None
                                if action == "click":
                                    self.assertEqual(Path(gate["releasePath"]).read_text(), gate["token"], "Input preceded the shared ready barrier")
                                    name = steps[-1]["name"]
                                    actions.append(name)
                                    if name == "Add download frame":
                                        adds += 1
                                        if mode == "gate-add-late":
                                            self.assertGreater(params["timeoutMs"], 0)
                                            self.assertLessEqual(params["timeoutMs"], 500)
                                            time.sleep(0.6)
                                    elif name == "Download original report":
                                        clicks += 1
                                        if mode == "click-and-cleanup-fail":
                                            failure = "click original failure"
                                    else:
                                        self.fail("Unexpected input target")
                                else:
                                    self.assertEqual((action, steps[-1].get("selector")), ("textContent", "#state"))
                                    leaf = variant == "root" or steps[0]["kind"] == "frame"
                                    state = {"key": "original-key", "kind": kind, "owner": "original-owner", "documentToken": "document-original",
                                             "expectedSHA": digest, "clicks": [], "frameAdds": []}
                                    if leaf and clicks:
                                        click = {"trusted": True, "buttonCount": clicks, "documentToken": "document-original"}
                                        if kind == "blob":
                                            click.update(revoked=True, blobURL="blob:original")
                                            state["blobURL"] = "blob:original"
                                        state["clicks"] = [click]
                                    if not leaf and adds:
                                        state["frameAdds"] = [{"trusted": True}]
                                    value = json.dumps(state)
                                result = {"value": value, "engine": {"name": "playwright-crx", "version": "0.15.0", "playwrightVersion": "1.53.0"}}
                            else:
                                self.fail(f"Unexpected method {method}")
                            response = {"id": request["id"], **({"error": {"message": failure}} if failure else {"result": result})}
                            conn.sendall(encode_frame(response))
                except BaseException as error:
                    errors.append(error)
                finally:
                    listener.close()

            thread = threading.Thread(target=serve, daemon=True)
            publisher = threading.Thread(target=publish_gate, daemon=True)
            thread.start()
            publisher.start()
            detail = (loaded_helper or helper).run({"socketPath": endpoint, "sessionId": "owner-session", "turnId": "original-turn", "controlEpoch": 7,
                                 "tabId": 9, "variant": variant, "key": "original-key", "kind": kind, "readyGate": gate})
            helper_done.set()
            publisher.join(timeout=2)
            self.assertFalse(publisher.is_alive(), "Gate publisher did not finish")
            thread.join(timeout=2)
            self.assertFalse(thread.is_alive(), "Original native connection did not close")
            if errors:
                raise errors[0]
            self.assertEqual(methods.count("getControlState"), 3, "Unexpected turn renewal")
            if not mode:
                self.assertTrue(detail["ok"], detail)
                self.assertEqual(detail["productPath"], str(path))
                self.assertEqual(detail["file"]["sha256"], digest)
                self.assertEqual(actions, (["Add download frame"] if variant == "dynamic-oopif" else []) + ["Download original report"])
            else:
                self.assertFalse(detail["ok"], detail)
                if mode == "changed-epoch":
                    self.assertEqual(detail["error"]["stage"], "scopeAfter")
                    self.assertEqual(actions, [])
                    self.assertNotIn("armDownloadWait", methods)
                elif mode.startswith("gate-"):
                    self.assertEqual(detail["error"]["stage"], "addFrame" if mode == "gate-add-late" else "gate")
                    self.assertEqual(actions, ["Add download frame"] if mode == "gate-add-late" else [])
                    if mode == "gate-add-late":
                        self.assertEqual(detail["error"]["type"], "TimeoutError")
                        self.assertIn("Original download wait deadline expired", detail["error"]["message"])
                    self.assertEqual(methods.count("cancelDownloadWait"), 1)
                    self.assertNotIn("collectDownloadWait", methods)
                    self.assertNotIn("downloadPath", methods)
                    self.assertNotIn("triggerAt", detail)
                    self.assertTrue(detail["waitCleanup"]["ok"])
                    self.assertEqual(detail["stages"][-1]["name"], "close")
                    self.assertTrue(detail["stages"][-1]["ok"])
                else:
                    self.assertEqual(detail["error"]["message"], "click original failure")
                    self.assertEqual(detail["waitCleanup"]["error"]["message"], "cleanup original failure")
                    self.assertEqual(actions, ["Download original report"])

    def test_typed_six_cases_keep_original_scope_and_single_trigger(self):
        for variant in ("root", "oopif", "dynamic-oopif"):
            for kind in ("post", "blob"):
                with self.subTest(variant=variant, kind=kind):
                    self.exercise(variant, kind)

    def test_actual_run_directory_copy_uses_repository_tmp(self):
        runs = SDK.parents[1] / ".tmp/browser-integration"
        runs.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="run-python-copy-test-", dir=runs) as directory:
            copied = Path(directory) / "python-original-download-checks.py"
            shutil.copyfile(Path(__file__).with_name("python-original-download-checks.py"), copied)
            copied_spec = importlib.util.spec_from_file_location("copied_original_download_helper", copied)
            module = importlib.util.module_from_spec(copied_spec)
            copied_spec.loader.exec_module(module)
            with chdir(directory):
                module.validate_gate({"readyPath": str(Path(directory) / "ready.json"),
                                      "releasePath": str(Path(directory) / "release"), "token": "copied-helper"})
                for parent in (SDK.parents[1] / ".tmp", SDK.parents[1] / "scripts"):
                    with self.assertRaisesRegex(ValueError, "dedicated repository .tmp"):
                        module.validate_gate({"readyPath": str(parent / "ready-copy-test.json"),
                                              "releasePath": str(parent / "release-copy-test"), "token": "copied-helper"})
                self.exercise(loaded_helper=module)

    def test_late_add_ack_cleans_up_without_download_click(self):
        self.exercise(variant="dynamic-oopif", mode="gate-add-late")

    def test_changed_epoch_stops_before_ready(self):
        self.exercise(mode="changed-epoch")

    def test_original_click_error_survives_cleanup_error_without_retry(self):
        self.exercise(mode="click-and-cleanup-fail")

    def test_expired_gate_cleans_up_without_adding_frame_or_clicking(self):
        self.exercise(variant="dynamic-oopif", mode="gate-timeout")

    def test_unknown_gate_token_cleans_up_without_adding_frame_or_clicking(self):
        self.exercise(variant="dynamic-oopif", mode="gate-token")

    def test_file_reader_rejects_nonregular_oversize_or_malformed(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises((OSError, ValueError)):
                helper.read_original_file(directory)
            path = Path(directory) / "bad.bin"
            for value in (b"", b"not-json\n", b'{"key":"x","kind":"post","owner":"y","nonce":"wrong"}\n', b"0" * 65537):
                path.write_bytes(value)
                with self.subTest(size=len(value)), self.assertRaises(ValueError):
                    helper.read_original_file(str(path))


if __name__ == "__main__":
    unittest.main()
