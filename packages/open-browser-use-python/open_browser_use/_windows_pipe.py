"""Windows byte-mode named pipes with cancellable, bounded overlapped I/O.

Imported only on Windows. No pywin32 dependency is needed.
"""

from __future__ import annotations

import ctypes
import math
import time
from ctypes import wintypes

from ._transport import remaining_time


class _Overlapped(ctypes.Structure):
    _fields_ = [
        ("Internal", ctypes.c_size_t),
        ("InternalHigh", ctypes.c_size_t),
        ("Offset", wintypes.DWORD),
        ("OffsetHigh", wintypes.DWORD),
        ("hEvent", wintypes.HANDLE),
    ]


_kernel = ctypes.WinDLL("kernel32", use_last_error=True)
_overlapped_pointer = ctypes.POINTER(_Overlapped)
_dword_pointer = ctypes.POINTER(wintypes.DWORD)
_kernel.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                              wintypes.LPVOID, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
_kernel.CreateFileW.restype = wintypes.HANDLE
_kernel.WaitNamedPipeW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD]
_kernel.WaitNamedPipeW.restype = wintypes.BOOL
_kernel.CreateEventW.argtypes = [wintypes.LPVOID, wintypes.BOOL, wintypes.BOOL, wintypes.LPCWSTR]
_kernel.CreateEventW.restype = wintypes.HANDLE
for _name in ("ReadFile", "WriteFile"):
    _function = getattr(_kernel, _name)
    _function.argtypes = [wintypes.HANDLE, wintypes.LPVOID, wintypes.DWORD,
                         _dword_pointer, _overlapped_pointer]
    _function.restype = wintypes.BOOL
_kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
_kernel.WaitForSingleObject.restype = wintypes.DWORD
_kernel.GetOverlappedResult.argtypes = [wintypes.HANDLE, _overlapped_pointer,
                                     _dword_pointer, wintypes.BOOL]
_kernel.GetOverlappedResult.restype = wintypes.BOOL
_kernel.CancelIoEx.argtypes = [wintypes.HANDLE, _overlapped_pointer]
_kernel.CancelIoEx.restype = wintypes.BOOL
_kernel.CloseHandle.argtypes = [wintypes.HANDLE]
_kernel.CloseHandle.restype = wintypes.BOOL

_INVALID_HANDLE = ctypes.c_void_p(-1).value
_ERROR_PIPE_BUSY = 231
_ERROR_IO_PENDING = 997
_BROKEN_PIPE_ERRORS = (109, 232, 233)
_WAIT_TIMEOUT = 258
_CHUNK_SIZE = 1024 * 1024


def _milliseconds(deadline: float) -> int:
    # INFINITE is reserved; rounding up avoids a zero (default wait) timeout.
    return min(math.ceil(remaining_time(deadline) * 1000), 0xFFFFFFFE)


class WindowsPipe:
    def __init__(self, handle: int, timeout: float) -> None:
        self._handle: int | None = handle
        self._timeout = timeout

    @classmethod
    def connect(cls, path: str, timeout: float) -> "WindowsPipe":
        deadline = time.monotonic() + timeout
        while True:
            remaining_time(deadline)
            # OVERLAPPED plus SECURITY_IDENTIFICATION: the local server may
            # identify its client, but cannot impersonate it with this handle.
            handle = _kernel.CreateFileW(path, 0xC0000000, 0, None, 3,
                                         0x40000000 | 0x00100000 | 0x00010000, None)
            if handle != _INVALID_HANDLE:
                return cls(handle, timeout)
            error = ctypes.get_last_error()
            if error != _ERROR_PIPE_BUSY:
                raise ctypes.WinError(error)
            if not _kernel.WaitNamedPipeW(path, _milliseconds(deadline)):
                error = ctypes.get_last_error()
                if error == 121:  # ERROR_SEM_TIMEOUT
                    raise TimeoutError("Open Browser Use pipe connection timed out")
                raise ctypes.WinError(error)

    def settimeout(self, timeout: float) -> None:
        self._timeout = timeout

    def close(self) -> None:
        handle, self._handle = self._handle, None
        if handle is not None:
            _kernel.CloseHandle(handle)

    def recv(self, length: int) -> bytes:
        if length <= 0:
            return b""
        buffer = ctypes.create_string_buffer(min(length, _CHUNK_SIZE))
        size = self._transfer(buffer, len(buffer), write=False,
                              deadline=time.monotonic() + self._timeout)
        return buffer.raw[:size]

    def sendall(self, data: bytes) -> None:
        deadline = time.monotonic() + self._timeout
        offset = 0
        while offset < len(data):
            chunk = data[offset:offset + _CHUNK_SIZE]
            buffer = ctypes.create_string_buffer(chunk)
            size = self._transfer(buffer, len(chunk), write=True, deadline=deadline)
            if not size:
                raise BrokenPipeError("Open Browser Use pipe closed during write")
            offset += size

    def _transfer(self, buffer: ctypes.Array, size: int, *, write: bool,
                  deadline: float) -> int:
        handle = self._handle
        if handle is None:
            raise OSError("Open Browser Use pipe is closed")
        remaining_time(deadline)
        event = _kernel.CreateEventW(None, True, False, None)
        if not event:
            raise ctypes.WinError(ctypes.get_last_error())
        overlapped = _Overlapped(hEvent=event)
        transferred = wintypes.DWORD()
        pending = False
        try:
            function = _kernel.WriteFile if write else _kernel.ReadFile
            if not function(handle, buffer, size, ctypes.byref(transferred), ctypes.byref(overlapped)):
                error = ctypes.get_last_error()
                if not write and error in _BROKEN_PIPE_ERRORS:
                    return 0
                if error != _ERROR_IO_PENDING:
                    raise ctypes.WinError(error)
                pending = True
                result = _kernel.WaitForSingleObject(event, _milliseconds(deadline))
                if result == _WAIT_TIMEOUT:
                    raise TimeoutError("Open Browser Use pipe operation timed out")
                if result != 0:
                    raise ctypes.WinError(ctypes.get_last_error())
            if not _kernel.GetOverlappedResult(handle, ctypes.byref(overlapped),
                                               ctypes.byref(transferred), False):
                error = ctypes.get_last_error()
                if not write and error in _BROKEN_PIPE_ERRORS:
                    return 0
                raise ctypes.WinError(error)
            pending = False
            return transferred.value
        finally:
            if pending:
                # Cancellation is asynchronous. Keep both the buffer and the
                # OVERLAPPED alive until the kernel has finished using them.
                _kernel.CancelIoEx(handle, ctypes.byref(overlapped))
                _kernel.GetOverlappedResult(handle, ctypes.byref(overlapped),
                                            ctypes.byref(transferred), True)
            _kernel.CloseHandle(event)
