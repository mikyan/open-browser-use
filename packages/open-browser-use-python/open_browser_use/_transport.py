"""Local byte-stream transports used by the native messaging protocol."""

from __future__ import annotations

import os
import socket
import time
from typing import Protocol


class Transport(Protocol):
    def sendall(self, data: bytes) -> None: ...
    def recv(self, length: int) -> bytes: ...
    def settimeout(self, timeout: float) -> None: ...
    def close(self) -> None: ...


def remaining_time(deadline: float) -> float:
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise TimeoutError("Open Browser Use request timed out")
    return remaining


def connect_transport(path: str, timeout: float) -> Transport:
    if os.name == "nt":
        if not path.lower().startswith("\\\\.\\pipe\\"):
            raise ValueError(
                "Windows requires a local named-pipe endpoint (\\\\.\\pipe\\...). "
                "Update the native host and use socketPath from its active.json."
            )
        from ._windows_pipe import WindowsPipe

        return WindowsPipe.connect(path, timeout)

    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        sock.settimeout(timeout)
        sock.connect(path)
    except BaseException:
        sock.close()
        raise
    return sock
