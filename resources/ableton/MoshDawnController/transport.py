"""Reconnectable loopback NDJSON client for the native bridge."""

from __future__ import annotations

import socket
from collections import deque
from typing import Deque, Dict, List, Optional

from .model import JsonValue, Request, Response
from .protocol import (
    Descriptor, ProtocolError, hello_line, load_descriptor, parse_request,
    response_line, snapshot_line,
)


MAX_BUFFER_BYTES = 65536


class LoopbackClient:
    """Non-blocking client polled by Live's scheduled main-thread tick."""

    def __init__(self, descriptor_path: str):
        self.descriptor_path = descriptor_path
        self.connected = False
        self._socket: Optional[socket.socket] = None
        self._buffer = b""
        self._requests: Deque[Request] = deque()
        self._retry_ticks = 0
        self._retry_delay = 1

    def poll(self) -> None:
        if self._socket is None:
            if self._retry_ticks > 0:
                self._retry_ticks -= 1
                return
            self._connect()
            return
        try:
            chunk = self._socket.recv(4096)
        except BlockingIOError:
            return
        except OSError:
            self._disconnect()
            return
        if not chunk:
            self._disconnect()
            return
        self._buffer += chunk
        if len(self._buffer) > MAX_BUFFER_BYTES:
            self._disconnect()
            return
        lines = self._buffer.split(b"\n")
        self._buffer = lines.pop()
        try:
            for line in lines:
                if line:
                    self._requests.append(parse_request(line.decode("utf-8")))
        except (ProtocolError, UnicodeDecodeError):
            self._requests.clear()
            self._disconnect()

    def take_requests(self) -> List[Request]:
        requests = list(self._requests)
        self._requests.clear()
        return requests

    def send_snapshot(self, state: Dict[str, JsonValue]) -> None:
        self._send(snapshot_line(state))

    def send_response(self, response: Response) -> None:
        self._send(response_line(response))

    def close(self) -> None:
        self._disconnect()

    def _connect(self) -> None:
        bridge_socket = None  # type: Optional[socket.socket]
        try:
            descriptor = load_descriptor(self.descriptor_path)
            bridge_socket = self._open_socket(descriptor)
            bridge_socket.sendall(hello_line(descriptor.secret))
        except (OSError, ProtocolError):
            if bridge_socket is not None:
                try:
                    bridge_socket.close()
                except OSError:
                    bridge_socket = None
            self._disconnect()
            self._schedule_retry()
            return
        self._socket = bridge_socket
        self.connected = True
        self._retry_delay = 1

    @staticmethod
    def _open_socket(descriptor: Descriptor) -> socket.socket:
        bridge_socket = socket.create_connection((descriptor.host, descriptor.port), timeout=0.05)
        bridge_socket.setblocking(False)
        return bridge_socket

    def _send(self, payload: bytes) -> None:
        if self._socket is None:
            return
        try:
            self._socket.sendall(payload)
        except OSError:
            self._disconnect()

    def _disconnect(self) -> None:
        bridge_socket = self._socket
        self._socket = None
        self.connected = False
        self._buffer = b""
        if bridge_socket is not None:
            try:
                bridge_socket.close()
            except OSError:
                return

    def _schedule_retry(self) -> None:
        self._retry_ticks = self._retry_delay
        self._retry_delay = min(self._retry_delay * 2, 100)
