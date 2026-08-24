"""Reconnect and queue behavior for the scheduled loopback client."""

from __future__ import annotations

import json
import os
import tempfile
import unittest

from ..model import Put
from ..transport import LoopbackClient


class FakeSocket:
    def __init__(self, chunks=()):
        self.chunks = list(chunks)
        self.sent = []
        self.closed = False

    def sendall(self, payload):
        self.sent.append(payload)

    def recv(self, size):
        if self.chunks:
            return self.chunks.pop(0)
        raise BlockingIOError

    def close(self):
        self.closed = True


class FakeClient(LoopbackClient):
    def __init__(self, descriptor_path, sockets):
        super().__init__(descriptor_path)
        self.sockets = list(sockets)

    def _open_socket(self, descriptor):
        return self.sockets.pop(0)


class TransportTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = os.path.join(self.directory.name, "remote-script.json")
        with open(self.path, "w", encoding="utf-8") as stream:
            json.dump({"protocol": 1, "host": "127.0.0.1", "port": 4567, "secret": "z" * 32}, stream)
        os.chmod(self.path, 0o600)

    def test_connect_sends_authenticated_versioned_hello(self):
        # Given
        bridge_socket = FakeSocket()
        client = FakeClient(self.path, [bridge_socket])

        # When
        client.poll()

        # Then
        hello = json.loads(bridge_socket.sent[0])
        self.assertEqual(hello, {"protocol": 1, "secret": "z" * 32, "type": "hello"})
        self.assertTrue(client.connected)

    def test_partial_ndjson_is_queued_only_after_complete_line(self):
        # Given
        bridge_socket = FakeSocket([
            b'{"protocol":1,"type":"action","requestId":"p",',
            b'"expectedRevision":0,"action":"put"}\n',
        ])
        client = FakeClient(self.path, [bridge_socket])
        client.poll()
        client.poll()
        self.assertEqual(client.take_requests(), [])

        # When
        client.poll()

        # Then
        requests = client.take_requests()
        self.assertEqual(len(requests), 1)
        self.assertEqual(requests[0].action, Put())

    def test_eof_disconnects_and_next_poll_reconnects(self):
        # Given
        first = FakeSocket([b""])
        second = FakeSocket()
        client = FakeClient(self.path, [first, second])
        client.poll()
        client.poll()

        # When
        client.poll()
        client.poll()

        # Then
        self.assertTrue(first.closed)
        self.assertTrue(client.connected)
        self.assertEqual(len(second.sent), 1)

    def test_malformed_action_disconnects_without_queueing(self):
        # Given
        bridge_socket = FakeSocket([b'{"protocol":1,"type":"action","action":{"method":"raw"}}\n'])
        client = FakeClient(self.path, [bridge_socket])
        client.poll()

        # When
        client.poll()

        # Then
        self.assertFalse(client.connected)
        self.assertEqual(client.take_requests(), [])


if __name__ == "__main__":
    unittest.main()
