"""Fake-ControlSurface tests for main-thread scheduling and teardown."""

from __future__ import annotations

import sys
import types
import unittest

from ..model import Put, Request
from .fakes import FakeSong, FakeTrack


class FakeControlSurface:
    def __init__(self, c_instance):
        self._c_instance = c_instance
        self.scheduled = []
        self.base_disconnected = False

    def song(self):
        return self._c_instance.song()

    def schedule_message(self, delay, callback):
        self.scheduled.append((delay, callback))

    def disconnect(self):
        self.base_disconnected = True


ableton = types.ModuleType("ableton")
ableton.__path__ = []
v2 = types.ModuleType("ableton.v2")
v2.__path__ = []
control_surface = types.ModuleType("ableton.v2.control_surface")
control_surface.ControlSurface = FakeControlSurface
sys.modules["ableton"] = ableton
sys.modules["ableton.v2"] = v2
sys.modules["ableton.v2.control_surface"] = control_surface

from ..surface import MoshDawnController  # noqa: E402
from .. import create_instance  # noqa: E402


class FakeCInstance:
    def __init__(self, song):
        self._song = song

    def song(self):
        return self._song


class FakeClient:
    def __init__(self, request):
        self.request = request
        self.connected = True
        self.responses = []
        self.snapshots = []
        self.closed = False

    def poll(self):
        pass

    def take_requests(self):
        request = self.request
        self.request = None
        return [] if request is None else [request]

    def send_response(self, response):
        self.responses.append(response)

    def send_snapshot(self, snapshot):
        self.snapshots.append(snapshot)

    def close(self):
        self.closed = True


class SurfaceTests(unittest.TestCase):
    def test_live_factory_returns_controller_instance(self):
        # Given
        c_instance = FakeCInstance(FakeSong([FakeTrack("Lead", armed=True)]))

        # When
        controller = create_instance(c_instance)

        # Then
        self.assertIsInstance(controller, MoshDawnController)

    def test_network_poll_schedules_lom_mutation_for_later_main_thread_turn(self):
        # Given
        song = FakeSong([FakeTrack("Lead", armed=True)])
        surface = MoshDawnController(FakeCInstance(song))
        surface._client = FakeClient(Request("put", 0, Put()))

        # When
        surface._poll()

        # Then
        self.assertFalse(song.record_mode)
        drain = next(callback for _, callback in surface.scheduled if callback.__name__ == "_drain_actions")
        drain()
        self.assertTrue(song.record_mode)
        self.assertEqual(len(surface._client.responses), 1)

    def test_disconnect_closes_socket_and_calls_live_base_teardown(self):
        # Given
        song = FakeSong([FakeTrack("Lead", armed=True)])
        surface = MoshDawnController(FakeCInstance(song))
        client = FakeClient(None)
        surface._client = client

        # When
        surface.disconnect()

        # Then
        self.assertTrue(client.closed)
        self.assertTrue(surface.base_disconnected)


if __name__ == "__main__":
    unittest.main()
