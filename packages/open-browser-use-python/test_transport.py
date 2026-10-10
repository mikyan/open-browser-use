import contextlib
import os
import struct
import tempfile
import threading
import time
import unittest

from open_browser_use.client import OpenBrowserUseClient, encode_frame, read_frame, MAX_FRAME_SIZE
from test_transport_support import local_server


@contextlib.contextmanager
def serve(callback):
    with tempfile.TemporaryDirectory() as directory:
        path, server = local_server(directory)
        errors = []

        def run():
            try:
                conn, _ = server.accept()
                with conn:
                    callback(conn)
            except BaseException as error:
                errors.append(error)
            finally:
                server.close()

        thread = threading.Thread(target=run, daemon=True)
        thread.start()
        try:
            yield path
        finally:
            thread.join(6)
            if thread.is_alive():
                raise AssertionError("IPC fixture did not finish")
            if errors:
                raise errors[0]


class TransportTest(unittest.TestCase):
    def test_fragmented_large_unicode_response(self):
        expected = "后台浏览器🙂" * 20000

        def respond(conn):
            request = read_frame(conn)
            frame = encode_frame({"id": request["id"], "result": expected})
            # Include partial headers and payloads larger than a pipe buffer.
            for chunk in (frame[:1], frame[1:3], frame[3:70000], frame[70000:]):
                conn.sendall(chunk)

        with serve(respond) as path:
            client = OpenBrowserUseClient(path, timeout=3)
            try:
                self.assertEqual(client.get_info(), expected)
            finally:
                client.close()

    def test_notifications_do_not_extend_request_deadline(self):
        def respond(conn):
            read_frame(conn)
            for _ in range(50):
                try:
                    conn.sendall(encode_frame({"method": "progress", "params": {}}))
                except OSError:
                    return
                time.sleep(0.02)

        with serve(respond) as path:
            client = OpenBrowserUseClient(path, timeout=0.15)
            notifications = []
            client.on_notification(notifications.append)
            started = time.monotonic()
            with self.assertRaises(TimeoutError):
                client.get_info()
            self.assertLess(time.monotonic() - started, 0.8)
            self.assertTrue(notifications)
            self.assertIsNone(client._socket)

    def test_partial_header_timeout_closes_stream(self):
        def respond(conn):
            read_frame(conn)
            conn.sendall(b"\x20\x00")
            time.sleep(0.3)

        with serve(respond) as path:
            client = OpenBrowserUseClient(path, timeout=0.1)
            with self.assertRaises(TimeoutError):
                client.get_info()
            self.assertIsNone(client._socket)

    def test_oversized_frame_rejected_before_payload(self):
        def respond(conn):
            read_frame(conn)
            conn.sendall(struct.pack("=I", MAX_FRAME_SIZE + 1))

        with serve(respond) as path:
            client = OpenBrowserUseClient(path)
            with self.assertRaisesRegex(ValueError, "64 MiB"):
                client.get_info()
            self.assertIsNone(client._socket)

    def test_eof_mid_frame_closes_stream(self):
        def respond(conn):
            read_frame(conn)
            conn.sendall(struct.pack("=I", 50) + b'{"id":')

        with serve(respond) as path:
            client = OpenBrowserUseClient(path)
            with self.assertRaises(EOFError):
                client.get_info()
            self.assertIsNone(client._socket)

    def test_rpc_error_does_not_break_healthy_connection(self):
        def respond(conn):
            first = read_frame(conn)
            conn.sendall(encode_frame({"id": first["id"], "error": {"message": "denied"}}))
            second = read_frame(conn)
            conn.sendall(encode_frame({"id": second["id"], "result": "still connected"}))

        with serve(respond) as path:
            client = OpenBrowserUseClient(path)
            try:
                with self.assertRaisesRegex(RuntimeError, "denied"):
                    client.get_info()
                self.assertEqual(client.get_info(), "still connected")
            finally:
                client.close()

    @unittest.skipUnless(os.name == "nt", "Windows path validation")
    def test_remote_pipe_path_is_rejected(self):
        client = OpenBrowserUseClient(r"\\another-machine\pipe\browser")
        with self.assertRaisesRegex(ValueError, "local named-pipe"):
            client.connect()


if __name__ == "__main__":
    unittest.main()
