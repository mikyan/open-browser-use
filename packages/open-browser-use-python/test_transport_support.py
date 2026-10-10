"""Bounded local IPC fixture, using the platform's actual SDK transport."""

import os
import socket
import uuid
from pathlib import Path


def local_server(directory):
    if os.name == "nt":
        path = "\\\\.\\pipe\\open-browser-use-test-" + str(uuid.uuid4())
        return path, _WindowsListener(path)
    path = str(Path(directory) / "obu.sock")
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.settimeout(5)
    server.bind(path)
    server.listen(1)
    return path, server


class _Connection:
    def __init__(self, pipe):
        self.pipe = pipe

    def recv(self, length):
        return self.pipe.recv(length)

    def sendall(self, data):
        self.pipe.sendall(data)

    def settimeout(self, timeout):
        self.pipe.settimeout(timeout)

    def close(self):
        self.pipe.close()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()


class _WindowsListener:
    def __init__(self, path):
        import ctypes
        from ctypes import wintypes
        from open_browser_use._windows_pipe import _kernel, _INVALID_HANDLE, _Overlapped

        self.ctypes, self.kernel, self.overlapped = ctypes, _kernel, _Overlapped
        _kernel.CreateNamedPipeW.argtypes = [wintypes.LPCWSTR] + [wintypes.DWORD] * 6 + [wintypes.LPVOID]
        _kernel.CreateNamedPipeW.restype = wintypes.HANDLE
        _kernel.ConnectNamedPipe.argtypes = [wintypes.HANDLE, ctypes.POINTER(_Overlapped)]
        _kernel.ConnectNamedPipe.restype = wintypes.BOOL
        self.handle = _kernel.CreateNamedPipeW(path, 3 | 0x40000000 | 0x80000, 0,
                                               1, 65536, 65536, 0, None)
        if self.handle == _INVALID_HANDLE:
            raise ctypes.WinError(ctypes.get_last_error())

    def accept(self):
        from ctypes import wintypes
        from open_browser_use._windows_pipe import WindowsPipe

        kernel, ctypes = self.kernel, self.ctypes
        event = kernel.CreateEventW(None, True, False, None)
        if not event:
            raise ctypes.WinError(ctypes.get_last_error())
        overlap = self.overlapped(hEvent=event)
        pending = False
        count = wintypes.DWORD()
        try:
            if not kernel.ConnectNamedPipe(self.handle, ctypes.byref(overlap)):
                error = ctypes.get_last_error()
                if error == 997:
                    pending = True
                    if kernel.WaitForSingleObject(event, 5000) != 0:
                        raise TimeoutError("Test pipe accept timed out")
                    if not kernel.GetOverlappedResult(self.handle, ctypes.byref(overlap), ctypes.byref(count), False):
                        raise ctypes.WinError(ctypes.get_last_error())
                    pending = False
                elif error != 535:  # ERROR_PIPE_CONNECTED
                    raise ctypes.WinError(error)
            handle, self.handle = self.handle, None
            return _Connection(WindowsPipe(handle, 5)), None
        finally:
            if pending:
                kernel.CancelIoEx(self.handle, ctypes.byref(overlap))
                kernel.GetOverlappedResult(self.handle, ctypes.byref(overlap), ctypes.byref(count), True)
            kernel.CloseHandle(event)

    def close(self):
        if self.handle is not None:
            self.kernel.CloseHandle(self.handle)
            self.handle = None
