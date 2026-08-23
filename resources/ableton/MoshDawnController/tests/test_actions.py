"""Behavior tests derived from the original DAWN Lua actions."""

from __future__ import annotations

import unittest

from ..model import Again, Hear, Keep, Put, Seek, Stop
from .fakes import FakeTrack, Rig


class RecordingTests(unittest.TestCase):
    def test_put_records_on_topmost_armed_audio_track_without_changing_arms(self):
        # Given
        midi = FakeTrack("MIDI", armed=True, audio=False)
        top = FakeTrack("Vocal A", armed=True)
        lower = FakeTrack("Vocal B", armed=True)
        rig = Rig([midi, top, lower])

        # When
        response = rig.act(Put())

        # Then
        self.assertTrue(response.ok)
        self.assertIs(rig.engine.state.active_source, top)
        self.assertEqual([midi.arm, top.arm, lower.arm], [True, True, True])

    def test_long_keep_archives_take_moves_marker_one_bar_and_records_again(self):
        # Given
        source = FakeTrack("Lead", armed=True)
        destination = FakeTrack("Archive")
        rig = Rig([source, destination])
        rig.act(Put())
        recorded = rig.finish_pass(12.0)

        # When
        response = rig.act(Keep())

        # Then
        self.assertTrue(response.ok)
        self.assertNotIn(recorded, source.arrangement_clips)
        self.assertEqual([(clip.start_time, clip.end_time) for clip in destination.arrangement_clips], [(0.0, 12.0)])
        self.assertEqual(rig.engine.state.edit_marker, 8.0)
        self.assertTrue(rig.song.record_mode)
        self.assertEqual(rig.song.begin_undo_calls, 1)
        self.assertEqual(rig.song.end_undo_calls, 1)

    def test_short_keep_leaves_marker_at_pass_start(self):
        # Given
        source = FakeTrack("Lead", armed=True)
        rig = Rig([source, FakeTrack("Archive")])
        rig.song.current_song_time = 20.0
        rig.engine.state.edit_marker = 20.0
        rig.act(Put())
        rig.finish_pass(23.5)

        # When
        response = rig.act(Keep())

        # Then
        self.assertTrue(response.ok)
        self.assertEqual(rig.engine.state.edit_marker, 20.0)

    def test_again_deletes_only_pending_take_and_keeps_marker(self):
        # Given
        source = FakeTrack("Lead", armed=True)
        older = source.add_clip(-8.0, -4.0, "Older")
        rig = Rig([source])
        rig.act(Put())
        pending = rig.finish_pass(8.0)

        # When
        response = rig.act(Again())

        # Then
        self.assertTrue(response.ok)
        self.assertEqual(source.arrangement_clips, [older])
        self.assertNotIn(pending, source.arrangement_clips)
        self.assertEqual(rig.engine.state.edit_marker, 0.0)
        self.assertTrue(rig.song.record_mode)

    def test_hear_ends_pass_retains_take_and_plays_from_marker(self):
        # Given
        source = FakeTrack("Lead", armed=True)
        rig = Rig([source])
        rig.act(Put())
        pending = rig.finish_pass(6.0)

        # When
        response = rig.act(Hear())

        # Then
        self.assertTrue(response.ok)
        self.assertIs(rig.engine.state.pending_clip, pending)
        self.assertEqual(rig.song.current_song_time, 0.0)
        self.assertTrue(rig.song.is_playing)
        self.assertFalse(rig.song.record_mode)

    def test_stop_ends_pass_retains_take_and_returns_to_marker(self):
        # Given
        source = FakeTrack("Lead", armed=True)
        rig = Rig([source])
        rig.act(Put())
        pending = rig.finish_pass(6.0)

        # When
        response = rig.act(Stop())

        # Then
        self.assertTrue(response.ok)
        self.assertIs(rig.engine.state.pending_clip, pending)
        self.assertEqual(rig.song.current_song_time, 0.0)
        self.assertFalse(rig.song.is_playing)

    def test_put_with_pending_take_performs_full_keep(self):
        # Given
        source = FakeTrack("Lead", armed=True)
        destination = FakeTrack("Archive")
        rig = Rig([source, destination])
        rig.act(Put())
        rig.finish_pass(8.0)
        rig.act(Stop())

        # When
        response = rig.act(Put())

        # Then
        self.assertTrue(response.ok)
        self.assertEqual(len(destination.arrangement_clips), 1)
        self.assertIsNone(rig.engine.state.pending_clip)
        self.assertTrue(rig.song.record_mode)

    def test_seek_is_blocked_while_recording(self):
        # Given
        rig = Rig([FakeTrack("Lead", armed=True)])
        rig.act(Put())

        # When
        response = rig.act(Seek(32.0))

        # Then
        self.assertFalse(response.ok)
        self.assertEqual(response.error, "seek_while_recording")
        self.assertEqual(rig.song.current_song_time, 0.0)

    def test_seek_moves_marker_when_stopped(self):
        # Given
        rig = Rig([FakeTrack("Lead", armed=True)])

        # When
        response = rig.act(Seek(32.0))

        # Then
        self.assertTrue(response.ok)
        self.assertEqual(rig.engine.state.edit_marker, 32.0)
        self.assertEqual(rig.song.current_song_time, 32.0)


if __name__ == "__main__":
    unittest.main()
