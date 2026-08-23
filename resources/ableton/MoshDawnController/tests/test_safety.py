"""Revision, identity, invalidation, and compensation tests."""

from __future__ import annotations

import unittest

from ..model import Again, Keep, Put, Request, Seek, Stop
from .fakes import FakeSong, FakeTrack, InjectedLiveError, Rig


class SafetyTests(unittest.TestCase):
    def test_request_ids_remain_idempotent_beyond_256_actions(self):
        # Given
        rig = Rig([FakeTrack("Lead", armed=True)])
        first = rig.act(Seek(1.0), request_id="first")
        for index in range(1, 300):
            rig.act(Seek(float(index + 1)), request_id="seek-%d" % index)

        # When
        replay = rig.engine.handle(rig.song, Request("first", 999, Put()))

        # Then
        self.assertIs(replay, first)
        self.assertEqual(rig.engine.state.revision, 300)

    def test_stale_revision_rejects_without_mutation(self):
        # Given
        rig = Rig([FakeTrack("Lead", armed=True)])

        # When
        response = rig.act(Put(), expected=7)

        # Then
        self.assertFalse(response.ok)
        self.assertEqual(response.error, "stale_revision")
        self.assertFalse(rig.song.record_mode)
        self.assertEqual(response.revision, 0)

    def test_duplicate_request_id_replays_original_result(self):
        # Given
        rig = Rig([FakeTrack("Lead", armed=True)])
        first = rig.act(Put(), request_id="same")

        # When
        duplicate = rig.engine.handle(rig.song, Request("same", 999, Keep()))

        # Then
        self.assertIs(duplicate, first)
        self.assertEqual(rig.engine.state.revision, 1)

    def test_set_invalidation_is_rejected(self):
        # Given
        rig = Rig([FakeTrack("Lead", armed=True)])
        replacement = FakeSong([FakeTrack("Other", armed=True)])

        # When
        response = rig.engine.handle(replacement, Request("set", 0, Put()))

        # Then
        self.assertFalse(response.ok)
        self.assertEqual(response.error, "set_invalidated")
        self.assertFalse(replacement.record_mode)

    def test_source_track_invalidation_is_rejected_after_stop(self):
        # Given
        source = FakeTrack("Lead", armed=True)
        rig = Rig([source])
        rig.act(Put())
        rig.finish_pass(4.0)
        rig.song.tracks.remove(source)

        # When
        response = rig.act(Stop())

        # Then
        self.assertFalse(response.ok)
        self.assertEqual(response.error, "source_track_invalidated")

    def test_pending_clip_invalidation_blocks_keep(self):
        # Given
        source = FakeTrack("Lead", armed=True)
        rig = Rig([source])
        rig.act(Put())
        pending = rig.finish_pass(4.0)
        rig.act(Stop())
        pending.remove()

        # When
        response = rig.act(Keep())

        # Then
        self.assertFalse(response.ok)
        self.assertEqual(response.error, "pending_clip_invalidated")
        self.assertIsNone(response.state["pendingClip"])
        self.assertIsNone(response.state["activeSource"])
        self.assertTrue(rig.engine.state.ownership_uncertain)

    def test_invalid_pending_proxy_is_not_dereferenced_by_snapshot(self):
        # Given
        class InvalidClipProxy:
            @property
            def name(self):
                raise InjectedLiveError("invalid Live proxy")

            @property
            def start_time(self):
                raise InjectedLiveError("invalid Live proxy")

            @property
            def end_time(self):
                raise InjectedLiveError("invalid Live proxy")

        source = FakeTrack("Lead", armed=True)
        rig = Rig([source])
        rig.engine.state.pending_source = source
        rig.engine.state.pending_clip = InvalidClipProxy()

        # When
        response = rig.act(Keep())

        # Then
        self.assertFalse(response.ok)
        self.assertEqual(response.error, "pending_clip_invalidated")
        self.assertIsNone(response.state["pendingClip"])
        self.assertEqual(response.state["blockedReason"], "pending_clip_invalidated")

    def test_multiple_new_recorded_clips_are_ambiguous(self):
        # Given
        source = FakeTrack("Lead", armed=True)
        rig = Rig([source])
        rig.act(Put())
        rig.finish_pass(4.0)
        source.add_clip(0.0, 4.0, "Second")

        # When
        response = rig.act(Stop())

        # Then
        self.assertFalse(response.ok)
        self.assertEqual(response.error, "ambiguous_recorded_clip")

    def test_late_keep_failure_closes_and_reverses_owned_undo_step(self):
        # Given
        source = FakeTrack("Lead", armed=True)
        destination = FakeTrack("Archive")
        destination.fail_duplicate = True
        rig = Rig([source, destination])
        rig.act(Put())
        rig.finish_pass(8.0)

        # When
        response = rig.act(Keep())

        # Then
        self.assertFalse(response.ok)
        self.assertEqual(response.error, "keep_compensated")
        self.assertEqual((rig.song.begin_undo_calls, rig.song.end_undo_calls, rig.song.undo_calls), (1, 1, 1))
        self.assertEqual(len(rig.song.tracks[0].arrangement_clips), 1)
        self.assertIs(rig.engine.state.pending_source, rig.song.tracks[0])
        self.assertIs(rig.engine.state.pending_clip, rig.song.tracks[0].arrangement_clips[0])

    def test_restart_failure_restores_edit_marker_after_undo(self):
        # Given
        source = FakeTrack("Lead", armed=True)
        rig = Rig([source, FakeTrack("Archive")])
        rig.act(Put())
        rig.finish_pass(8.0)
        rig.song.fail_start = True

        # When
        response = rig.act(Keep())

        # Then
        self.assertFalse(response.ok)
        self.assertEqual(response.error, "keep_compensated")
        self.assertEqual(rig.engine.state.edit_marker, 0.0)
        self.assertEqual(rig.song.current_song_time, 0.0)
        self.assertIsNone(rig.engine.state.active_source)
        self.assertIs(rig.engine.state.pending_source, rig.song.tracks[0])
        self.assertIs(rig.engine.state.pending_clip, rig.song.tracks[0].arrangement_clips[0])

    def test_ambiguous_undo_recovery_enters_explicit_ownership_block(self):
        # Given
        source = FakeTrack("Lead", armed=True)
        source.add_clip(0.0, 8.0, "Take")
        destination = FakeTrack("Archive")
        destination.fail_duplicate = True
        rig = Rig([source, destination])
        rig.act(Put())
        rig.finish_pass(8.0)

        # When
        response = rig.act(Keep())

        # Then
        self.assertFalse(response.ok)
        self.assertEqual(response.error, "keep_compensation_unresolved")
        self.assertTrue(rig.engine.state.ownership_uncertain)
        self.assertIsNone(response.state["pendingClip"])
        self.assertTrue(response.state["ownershipUncertain"])
        blocked = rig.act(Again())
        self.assertEqual(blocked.error, "pending_ownership_uncertain")


if __name__ == "__main__":
    unittest.main()
