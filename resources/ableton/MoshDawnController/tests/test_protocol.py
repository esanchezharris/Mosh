"""Typed boundary and loopback transport tests."""

from __future__ import annotations

import json
import os
import tempfile
import unittest

from ..model import Again, Hear, Keep, Put, Seek, Stop
from ..protocol import PROTOCOL_VERSION, ProtocolError, load_descriptor, parse_request


class ProtocolTests(unittest.TestCase):
    def test_mode_0600_loopback_descriptor_is_parsed(self):
        # Given
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "remote-script.json")
            with open(path, "w", encoding="utf-8") as stream:
                json.dump({"protocol": 1, "host": "127.0.0.1", "port": 4567, "secret": "s" * 32}, stream)
            os.chmod(path, 0o600)

            # When
            descriptor = load_descriptor(path)

            # Then
            self.assertEqual((descriptor.host, descriptor.port, descriptor.secret), ("127.0.0.1", 4567, "s" * 32))

    def test_group_readable_descriptor_is_rejected(self):
        # Given
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "remote-script.json")
            with open(path, "w", encoding="utf-8") as stream:
                json.dump({"protocol": 1, "host": "127.0.0.1", "port": 4567, "secret": "s" * 32}, stream)
            os.chmod(path, 0o640)

            # When / Then
            with self.assertRaisesRegex(ProtocolError, "descriptor_permissions"):
                load_descriptor(path)

    def test_non_loopback_descriptor_is_rejected(self):
        # Given
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "remote-script.json")
            with open(path, "w", encoding="utf-8") as stream:
                json.dump({"protocol": 1, "host": "0.0.0.0", "port": 4567, "secret": "s" * 32}, stream)
            os.chmod(path, 0o600)

            # When / Then
            with self.assertRaisesRegex(ProtocolError, "descriptor_host"):
                load_descriptor(path)

    def test_semantic_action_variants_are_parsed(self):
        # Given
        names = (("put", Put), ("keep", Keep), ("again", Again), ("hear", Hear), ("stop", Stop))

        # When
        parsed = [parse_request(json.dumps({"protocol": 1, "type": "action", "requestId": name, "expectedRevision": 0, "action": name})) for name, _ in names]

        # Then
        self.assertEqual([type(item.action) for item in parsed], [kind for _, kind in names])

    def test_seek_requires_a_finite_beat_position(self):
        # Given
        line = json.dumps({"protocol": 1, "type": "action", "requestId": "seek", "expectedRevision": 3, "action": "seek", "positionBeats": 12.5})

        # When
        request = parse_request(line)

        # Then
        self.assertEqual(request.action, Seek(12.5))

    def test_raw_method_surface_is_rejected(self):
        # Given
        line = json.dumps({"protocol": PROTOCOL_VERSION, "type": "action", "requestId": "raw", "expectedRevision": 0, "action": {"method": "delete_track"}})

        # When / Then
        with self.assertRaisesRegex(ProtocolError, "action"):
            parse_request(line)


if __name__ == "__main__":
    unittest.main()
