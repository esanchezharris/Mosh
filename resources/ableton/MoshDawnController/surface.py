"""Ableton ControlSurface lifecycle for the DAWN semantic engine."""

from __future__ import annotations

from typing import List

from ableton.v2.control_surface import ControlSurface

from .engine import DawnEngine
from .model import LiveCInstance, Request
from .protocol import default_descriptor_path
from .transport import LoopbackClient


class MoshDawnController(ControlSurface):
    """Schedule socket polling and all Song mutations through Live's main loop."""

    def __init__(self, c_instance: LiveCInstance):
        super().__init__(c_instance)
        self._engine = DawnEngine(self.song())
        self._client = LoopbackClient(default_descriptor_path())
        self._pending = []  # type: List[Request]
        self._drain_scheduled = False
        self._closed = False
        self._last_connected = False
        self.schedule_message(1, self._poll)

    def _poll(self) -> None:
        if self._closed:
            return
        self._client.poll()
        self._engine.set_connection(self._client.connected)
        if self._client.connected and not self._last_connected:
            self._client.send_snapshot(self._engine.snapshot())
        self._last_connected = self._client.connected
        self._pending.extend(self._client.take_requests())
        if self._pending and not self._drain_scheduled:
            self._drain_scheduled = True
            self.schedule_message(0, self._drain_actions)
        self.schedule_message(1, self._poll)

    def _drain_actions(self) -> None:
        self._drain_scheduled = False
        requests = self._pending
        self._pending = []
        for request in requests:
            response = self._engine.handle(self.song(), request)
            self._client.send_response(response)
            self._client.send_snapshot(response.state)

    def disconnect(self) -> None:
        self._closed = True
        self._pending = []
        self._client.close()
        super().disconnect()
