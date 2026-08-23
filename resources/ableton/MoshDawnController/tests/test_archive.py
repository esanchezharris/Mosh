"""Archive placement and Live-setting preservation tests."""

from __future__ import annotations

import unittest

from ..model import Keep, Put
from .fakes import FakeTrack, Rig


class ArchiveTests(unittest.TestCase):
    def test_keep_reuses_writable_non_overlapping_lower_audio_track(self):
        # Given
        source = FakeTrack("Lead", armed=True)
        lower = FakeTrack("Existing")
        lower.add_clip(16.0, 20.0, "Later")
        rig = Rig([source, lower])
        rig.act(Put())
        rig.finish_pass(8.0)

        # When
        response = rig.act(Keep())

        # Then
        self.assertTrue(response.ok)
        self.assertIs(rig.song.tracks[1], lower)
        self.assertEqual(len(lower.arrangement_clips), 2)
        self.assertFalse(lower.arm)

    def test_overlap_inserts_clean_source_duplicate_directly_below(self):
        # Given
        source = FakeTrack("Lead", armed=True)
        source.add_clip(-8.0, -4.0, "Unrelated")
        lower = FakeTrack("Existing")
        lower.add_clip(4.0, 10.0, "Overlap")
        rig = Rig([source, lower])
        rig.act(Put())
        rig.finish_pass(8.0)

        # When
        response = rig.act(Keep())

        # Then
        clone = rig.song.tracks[1]
        self.assertTrue(response.ok)
        self.assertEqual(clone.name, "Lead")
        self.assertFalse(clone.arm)
        self.assertEqual([(clip.start_time, clip.end_time) for clip in clone.arrangement_clips], [(0.0, 8.0)])
        self.assertIs(rig.song.tracks[2], lower)

    def test_armed_lower_next_target_forces_archive_clone_and_stays_armed(self):
        # Given
        source = FakeTrack("Lead", armed=True)
        lower = FakeTrack("Next Mic", armed=True)
        rig = Rig([source, lower])
        rig.act(Put())
        rig.finish_pass(8.0)
        source.arm = False

        # When
        response = rig.act(Keep())

        # Then
        self.assertTrue(response.ok)
        self.assertEqual(rig.song.tracks[1].name, "Lead")
        self.assertFalse(rig.song.tracks[1].arm)
        self.assertIs(rig.engine.state.active_source, lower)
        self.assertTrue(lower.arm)

    def test_bar_length_uses_captured_time_signature(self):
        # Given
        source = FakeTrack("Lead", armed=True)
        rig = Rig([source, FakeTrack("Archive")])
        rig.song.signature_numerator = 3
        rig.song.signature_denominator = 8
        rig.act(Put())
        rig.finish_pass(4.0)

        # When
        response = rig.act(Keep())

        # Then
        self.assertTrue(response.ok)
        self.assertEqual(rig.engine.state.edit_marker, 2.5)

    def test_actions_do_not_change_live_recording_preferences(self):
        # Given
        source = FakeTrack("Lead", armed=True)
        rig = Rig([source, FakeTrack("Archive")])
        before = (rig.song.loop, rig.song.punch_in, rig.song.punch_out, rig.song.count_in_duration, rig.song.metronome)
        rig.act(Put())
        rig.finish_pass(8.0)

        # When
        response = rig.act(Keep())

        # Then
        self.assertTrue(response.ok)
        after = (rig.song.loop, rig.song.punch_in, rig.song.punch_out, rig.song.count_in_duration, rig.song.metronome)
        self.assertEqual(after, before)


if __name__ == "__main__":
    unittest.main()
