"""Small in-memory implementation of the Live objects used by DAWN."""

from __future__ import annotations


class InjectedLiveError(RuntimeError):
    """Deterministic fake-Live mutation failure."""


class FakeClip:
    def __init__(self, owner, start, end, name="Take"):
        self.owner = owner
        self.start_time = float(start)
        self.end_time = float(end)
        self.name = name
        self.is_audio_clip = True

    def remove(self):
        self.owner.delete_clip(self)


class FakeSessionClip:
    def __init__(self, name):
        self.name = name


class FakeClipSlot:
    def __init__(self, clip=None):
        self.clip = clip

    @property
    def has_clip(self):
        return self.clip is not None

    def delete_clip(self):
        self.clip = None


class FakeTrack:
    def __init__(self, name, armed=False, audio=True, frozen=False):
        self.name = name
        self.arm = armed
        self.has_audio_input = audio
        self.can_be_armed = True
        self.is_frozen = frozen
        self.arrangement_clips = []
        self.clip_slots = []
        self.fail_duplicate = False

    def add_clip(self, start, end, name="Take"):
        clip = FakeClip(self, start, end, name)
        self.arrangement_clips.append(clip)
        return clip

    def duplicate_clip_to_arrangement(self, clip, position):
        created = self.add_clip(position, position + clip.end_time - clip.start_time, clip.name)
        if self.fail_duplicate:
            raise InjectedLiveError("injected destination failure")
        return created

    def delete_clip(self, clip):
        self.arrangement_clips.remove(clip)

    def add_session_clip(self, name):
        self.clip_slots.append(FakeClipSlot(FakeSessionClip(name)))


class FakeSong:
    def __init__(self, tracks):
        self.tracks = list(tracks)
        self.current_song_time = 0.0
        self.record_mode = False
        self.is_playing = False
        self.signature_numerator = 4
        self.signature_denominator = 4
        self.loop = True
        self.punch_in = True
        self.punch_out = False
        self.count_in_duration = 2
        self.metronome = True
        self.begin_undo_calls = 0
        self.end_undo_calls = 0
        self.undo_calls = 0
        self._undo_snapshot = None
        self.fail_start = False

    def start_playing(self):
        if self.fail_start:
            self.fail_start = False
            raise InjectedLiveError("injected start failure")
        self.is_playing = True

    def stop_playing(self):
        self.is_playing = False

    def begin_undo_step(self):
        self.begin_undo_calls += 1
        self._undo_snapshot = [
            (
                track.name,
                track.arm,
                track.has_audio_input,
                track.is_frozen,
                [(clip.start_time, clip.end_time, clip.name) for clip in track.arrangement_clips],
                [slot.clip.name if slot.has_clip else None for slot in track.clip_slots],
            )
            for track in self.tracks
        ]

    def end_undo_step(self):
        self.end_undo_calls += 1

    def undo(self):
        self.undo_calls += 1
        if self._undo_snapshot is not None:
            restored = []
            for name, arm, audio, frozen, clips, session_clips in self._undo_snapshot:
                track = FakeTrack(name, arm, audio, frozen)
                for start, end, clip_name in clips:
                    track.add_clip(start, end, clip_name)
                for clip_name in session_clips:
                    slot = FakeClipSlot()
                    if clip_name is not None:
                        slot.clip = FakeSessionClip(clip_name)
                    track.clip_slots.append(slot)
                restored.append(track)
            self.tracks = restored

    def duplicate_track(self, index):
        source = self.tracks[index]
        clone = FakeTrack(source.name, source.arm, source.has_audio_input, source.is_frozen)
        for clip in source.arrangement_clips:
            clone.add_clip(clip.start_time, clip.end_time, clip.name)
        for slot in source.clip_slots:
            clone_slot = FakeClipSlot()
            if slot.has_clip:
                clone_slot.clip = FakeSessionClip(slot.clip.name)
            clone.clip_slots.append(clone_slot)
        self.tracks.insert(index + 1, clone)


class Rig:
    def __init__(self, tracks):
        from ..engine import DawnEngine

        self.song = FakeSong(tracks)
        self.engine = DawnEngine(self.song)
        self.revision = 0

    def act(self, action, request_id=None, expected=None):
        from ..model import Request

        request = Request(
            request_id or "r%d" % (self.revision + 1),
            self.revision if expected is None else expected,
            action,
        )
        response = self.engine.handle(self.song, request)
        if response.revision > self.revision:
            self.revision = response.revision
        return response

    def finish_pass(self, stop):
        source = self.engine.state.active_source
        clip = source.add_clip(self.engine.state.pass_start, stop)
        self.song.current_song_time = stop
        return clip
