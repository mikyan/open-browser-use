"""Cross-language checks against the real host. Set OBU_TEST_HOST_BINARY to run."""

import json
import os
import subprocess
import tempfile
import threading
import time
import unittest
from pathlib import Path

from open_browser_use.client import OpenBrowserUseClient, encode_frame


def read_message(stream):
    import struct

    def exact(length):
        chunks = []
        while length:
            part = stream.read(length)
            if not part:
                raise EOFError()
            chunks.append(part)
            length -= len(part)
        return b"".join(chunks)

    length, = struct.unpack("=I", exact(4))
    return json.loads(exact(length))


@unittest.skipUnless(os.environ.get("OBU_TEST_HOST_BINARY"), "requires built native host")
class NativeHostIntegrationTest(unittest.TestCase):
    def test_round_trip_timeout_requires_new_client(self):
        with tempfile.TemporaryDirectory(prefix="obu-python-host-") as directory:
            process = subprocess.Popen(
                [os.environ["OBU_TEST_HOST_BINARY"], "host", "--socket-dir", directory],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
            )
            calls, errors = [], []

            def extension_peer():
                try:
                    while True:
                        request = read_message(process.stdout)
                        calls.append(request)
                        if request["params"].get("probe") == "late":
                            time.sleep(0.25)
                        reply = {"id": request["id"], "result": {
                            "session": request["params"]["session_id"],
                            "probe": request["params"].get("probe"),
                            "text": "原生主机🙂" * 15000,
                        }}
                        process.stdin.write(encode_frame(reply))
                        process.stdin.flush()
                except EOFError:
                    pass
                except BaseException as error:
                    errors.append(error)

            thread = threading.Thread(target=extension_peer, daemon=True)
            thread.start()
            client = None
            try:
                registry = Path(directory) / "active.json"
                deadline = time.monotonic() + 5
                while not registry.exists():
                    if time.monotonic() > deadline or process.poll() is not None:
                        self.fail("Native host did not publish active.json")
                    time.sleep(0.01)
                endpoint = json.loads(registry.read_text())["socketPath"]
                if os.name == "nt":
                    self.assertTrue(endpoint.startswith("\\\\.\\pipe\\"))
                client = OpenBrowserUseClient(endpoint, session_id="python-host-test", timeout=2)
                response = client.request("getInfo", {"probe": "first"})
                self.assertEqual(response["session"], "python-host-test")
                self.assertEqual(response["text"], "原生主机🙂" * 15000)
                client.timeout = 0.1
                with self.assertRaises(TimeoutError):
                    client.request("getInfo", {"probe": "late"})
                self.assertIsNone(client._socket)
                client.timeout = 2
                with self.assertRaisesRegex(RuntimeError, "OBU_SDK_BROWSER_DISCONNECTED"):
                    client.request("getInfo", {"probe": "stale after timeout"})
                with self.assertRaisesRegex(RuntimeError, "OBU_SDK_BROWSER_DISCONNECTED"):
                    client.connect()
                client = OpenBrowserUseClient(endpoint, session_id="python-host-test", timeout=2)
                self.assertEqual(client.request("getInfo", {"probe": "after timeout"})["probe"], "after timeout")
                self.assertEqual([call["params"]["probe"] for call in calls], ["first", "late", "after timeout"])
            finally:
                if client is not None:
                    client.close()
                process.stdin.close()
                try:
                    process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=3)
                thread.join(3)
                stderr = process.stderr.read().decode("utf-8", errors="replace")
                process.stdout.close()
                process.stderr.close()
            self.assertFalse(thread.is_alive())
            self.assertEqual(errors, [])
            self.assertEqual(process.returncode, 0, stderr)


if __name__ == "__main__":
    unittest.main()
