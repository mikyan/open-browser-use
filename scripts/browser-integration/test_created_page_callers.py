"""Typed Python/Go helpers over actual native IPC, with no browser or host."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "packages/open-browser-use-python"))
from open_browser_use.client import encode_frame, read_frame
from test_transport_support import local_server

spec = importlib.util.spec_from_file_location("created_page_helper", Path(__file__).with_name("python-created-page-checks.py"))
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
NONCE = "01234567-89ab-4cde-8fab-0123456789ab"
CHILD = "11111111-89ab-4cde-8fab-0123456789ab"
TOKEN = "22222222-89ab-4cde-8fab-0123456789ab"


class CreatedPageCallerTests(unittest.TestCase):
    def test_python_evidence_requires_boolean_trust_and_integer_sequence(self):
        before = {"documentNonce": CHILD, "documentToken": TOKEN, "clicks": []}
        for fields in ({"trusted": 1, "sequence": 1}, {"trusted": True, "sequence": True}, {"trusted": True, "sequence": 2}):
            with self.subTest(fields=fields), self.assertRaises(ValueError):
                helper.check_child({**before, "clicks": [{**fields, "documentNonce": CHILD, "documentToken": TOKEN}]}, before)

    def exercise(self, caller, variant="root", mode=""):
        with tempfile.TemporaryDirectory() as directory, tempfile.TemporaryDirectory(prefix="created-caller-gate-", dir=ROOT / ".tmp") as gate_dir:
            endpoint, listener = local_server(directory)
            gate = {"readyPath": str(Path(gate_dir) / "ready.json"), "releasePath": str(Path(gate_dir) / "release"), "token": "exact-created-gate"}
            config = {"socketPath": endpoint, "sessionId": "owner-session", "turnId": "original-turn", "controlEpoch": 7,
                      "tabId": 9, "variant": variant, "key": "case-key", "owner": "original-owner", "readyGate": gate}
            errors, requests, actions = [], [], []
            done, closed = threading.Event(), threading.Event()

            def release():
                try:
                    deadline = time.monotonic() + 4
                    while not done.is_set():
                        self.assertLess(time.monotonic(), deadline)
                        try:
                            ready = json.loads(Path(gate["readyPath"]).read_text(encoding="utf-8"))
                        except (FileNotFoundError, json.JSONDecodeError):
                            time.sleep(.002)
                            continue
                        self.assertEqual((ready["waiterId"], ready["tabId"], ready["token"]), ("w", 9, gate["token"]))
                        if mode == "gate-expired": return
                        temporary = Path(gate_dir) / "release.tmp"
                        temporary.write_text("wrong-token" if mode == "gate-token" else gate["token"], encoding="utf-8")
                        os.replace(temporary, gate["releasePath"])
                        return
                except BaseException as error:
                    errors.append(error)

            def serve():
                try:
                    conn, _ = listener.accept()
                    with conn:
                        clicks = adds = commits = 0
                        while True:
                            try: request = read_frame(conn)
                            except (EOFError, ConnectionError, BrokenPipeError): break
                            requests.append(request)
                            method, params = request["method"], request["params"]
                            self.assertEqual((params["session_id"], params["turn_id"]), ("owner-session", "original-turn"))
                            if method not in ("getInfo", "getControlState"): self.assertEqual(params["control_epoch"], 7)
                            value, failure = {}, None
                            if method == "getInfo":
                                value = {"metadata": {"turnLifecycleVersion": 1, "pageWaitVersion": 1}}
                            elif method == "getControlState":
                                value = {"lifecycleVersion": 1, "controlEpoch": 8 if mode == "scope" else 7, "closing": False, "nextTurnId": "must-not-adopt"}
                            elif method == "armPageWait":
                                self.assertGreater(params["timeoutMs"], 0)
                                self.assertLessEqual(params["timeoutMs"], 20000)
                                value = {"waiterId": "w", "remainingMs": 100 if mode == "gate-expired" else 1400 if mode == "add-late" else 15000}
                            elif method == "collectPageWait":
                                self.assertEqual(clicks, 1)
                                self.assertEqual(params["tabId"], 9)
                                value = {"tabId": 12}
                            elif method == "cancelPageWait":
                                self.assertEqual((params["tabId"], params["waiterId"]), (9, "w"))
                                if mode == "click-cleanup": failure = "cleanup original failure"
                            elif method == "browserAction":
                                action, steps = params["action"], params["locator"]
                                leaf = steps[-1]
                                if action in ("click", "fill"):
                                    self.assertEqual(Path(gate["releasePath"]).read_text(), gate["token"])
                                    actions.append((action, leaf.get("selector", leaf.get("value"))))
                                result = None
                                if action == "click":
                                    if leaf.get("selector") == "#add-frame":
                                        adds += 1
                                        if mode == "add-late": time.sleep(1.6)
                                    elif leaf.get("selector") == "#open-child":
                                        self.assertEqual(params["args"]["modifiers"], ["Control"])
                                        clicks += 1
                                        if mode == "click-cleanup": failure = "trigger original failure"
                                    elif leaf.get("selector") == "#commit":
                                        self.assertEqual(params["tabId"], 12)
                                        commits += 1
                                    else: self.fail(f"Unknown click {leaf}")
                                elif action == "fill":
                                    self.assertEqual(params["tabId"], 12)
                                    self.assertIn(params["args"]["value"], ("case-key", "original-owner"))
                                elif action == "textContent":
                                    if leaf.get("selector") == "#result":
                                        result = json.dumps({"ok": True, "key": "case-key", "owner": "original-owner", "documentNonce": CHILD})
                                    elif params["tabId"] == 12:
                                        child_click = {"trusted": True, "sequence": 1, "documentNonce": CHILD, "documentToken": TOKEN}
                                        result = json.dumps({"documentNonce": CHILD, "documentToken": TOKEN, "clicks": [child_click] if commits else []})
                                    else:
                                        is_frame = steps[0].get("kind") == "frame"
                                        source = {"key": "case-key", "owner": "original-owner", "variant": variant, "sourceNonce": NONCE,
                                                  "documentToken": TOKEN, "clicks": [], "frameAdds": []}
                                        if clicks and (variant == "root" or is_frame):
                                            source["clicks"] = [{"trusted": True, "ctrlKey": True, "metaKey": False, "altKey": False, "shiftKey": False,
                                                                 "button": 0, "sequence": 1, "sourceNonce": NONCE, "documentToken": TOKEN, "href": "http://same.test/child"}]
                                        if adds and not is_frame: source["frameAdds"] = [{"trusted": True, "sequence": 1}]
                                        result = json.dumps(source)
                                else: self.fail(f"Unknown action {action}")
                                value = {"value": result, "engine": {"name": "playwright-crx", "version": "0.15.0", "playwrightVersion": "1.53.0"}}
                            else: self.fail(f"Unexpected/replayed/claim operation {method}")
                            response = {"id": request["id"], **({"error": {"message": failure}} if failure else {"result": value})}
                            try: conn.sendall(encode_frame(response))
                            except (ConnectionError, BrokenPipeError, OSError):
                                if mode != "add-late": raise
                                break
                except BaseException as error:
                    errors.append(error)
                finally:
                    listener.close()
                    closed.set()

            server_thread, gate_thread = threading.Thread(target=serve, daemon=True), threading.Thread(target=release, daemon=True)
            server_thread.start(); gate_thread.start()
            try:
                if caller == "python": detail = helper.run(config)
                else:
                    process = subprocess.run([os.environ["OBU_CREATED_PAGE_GO_HELPER"]], input=json.dumps(config), text=True,
                                             encoding="utf-8", capture_output=True, timeout=30,
                                             creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0, cwd=ROOT)
                    detail = json.loads(process.stdout)
                    self.assertEqual(process.returncode, 0 if detail["ok"] else 1)
            finally:
                done.set()
            server_thread.join(3); gate_thread.join(3)
            self.assertTrue(closed.is_set(), "Original connection did not close")
            self.assertFalse(server_thread.is_alive()); self.assertFalse(gate_thread.is_alive())
            if errors: raise errors[0]
            self.assertEqual(detail["ok"], not mode, detail)
            self.assertTrue(detail["clientClose"]["ok"], detail)
            if not mode:
                self.assertEqual(detail["childId"], 12)
                self.assertEqual(detail["receipt"]["documentNonce"], CHILD)
                self.assertEqual(sum(action == ("click", "#open-child") for action in actions), 1)
                self.assertEqual(sum(action == ("click", "#commit") for action in actions), 1)
            elif mode in ("gate-token", "gate-expired", "scope", "add-late"):
                self.assertNotIn(("click", "#open-child"), actions)
            else:
                self.assertEqual(detail["error"]["message"], "trigger original failure")
                self.assertEqual(detail["waitCleanup"]["error"]["message"], "cleanup original failure")
            self.assertNotIn("claimUserTab", [row["method"] for row in requests])

    def test_python_typed_stages(self):
        for variant in ("root", "oopif", "dynamic-oopif"):
            with self.subTest(variant=variant): self.exercise("python", variant)

    def test_python_failures_never_retrigger(self):
        for mode in ("scope", "gate-token", "gate-expired", "add-late", "click-cleanup"):
            with self.subTest(mode=mode): self.exercise("python", "dynamic-oopif", mode)

    @unittest.skipUnless(os.environ.get("OBU_CREATED_PAGE_GO_HELPER"), "requires compiled Go helper")
    def test_go_typed_stages(self):
        for variant in ("root", "oopif", "dynamic-oopif"):
            with self.subTest(variant=variant): self.exercise("go", variant)

    @unittest.skipUnless(os.environ.get("OBU_CREATED_PAGE_GO_HELPER"), "requires compiled Go helper")
    def test_go_failures_never_retrigger(self):
        for mode in ("scope", "gate-token", "gate-expired", "add-late", "click-cleanup"):
            with self.subTest(mode=mode): self.exercise("go", "dynamic-oopif", mode)


if __name__ == "__main__": unittest.main()
