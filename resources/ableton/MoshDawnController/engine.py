"""DAWN semantic action state machine for Ableton Live."""

from __future__ import annotations

from typing import Callable, Dict, Optional, Tuple, Type

from .model import (
    Action, Again, Hear, JsonValue, Keep, LiveClip, LiveSong, LiveTrack, Put,
    Request, Response, Seek, SessionState, Stop,
)
from .topology import (
    clip_snapshot, record_target, track_index, track_present, track_snapshot,
    valid_archives,
)


class KeepMutationError(RuntimeError):
    """Controller-owned keep step produced an ambiguous late result."""


class DawnEngine:
    """Own one fail-closed recording workflow for one Live Set lifecycle."""

    def __init__(self, song: LiveSong):
        self.state = SessionState(song=song, edit_marker=float(song.current_song_time))
        self._results: Dict[str, Response] = {}
        self._handlers: Dict[Type[Action], Callable[[LiveSong, Action], Optional[str]]] = {
            Put: self._put, Keep: self._keep, Again: self._again,
            Hear: self._hear, Stop: self._stop, Seek: self._seek,
        }

    def handle(self, song: LiveSong, request: Request) -> Response:
        cached = self._results.get(request.request_id)
        if cached is not None:
            return cached
        if song is not self.state.song:
            return self._reject(request, "set_invalidated", cache=True)
        if request.expected_revision != self.state.revision:
            return self._reject(request, "stale_revision", cache=False)
        handler = self._handlers.get(type(request.action))
        if handler is None:
            return self._reject(request, "unsupported_action", cache=True)
        error = handler(song, request.action)
        self.state.blocked_reason = error
        self.state.revision += 1
        response = Response(error is None, request.request_id, self.state.revision, error, self.snapshot())
        self._remember(response)
        return response

    def snapshot(self) -> Dict[str, JsonValue]:
        source = self.state.pending_source or self.state.active_source
        return {
            "revision": self.state.revision,
            "connection": self.state.connection,
            "transport": self.state.transport,
            "editMarkerBeats": self.state.edit_marker,
            "activeSource": track_snapshot(source),
            "passStartBeats": self.state.pass_start,
            "savedStopBeats": self.state.saved_stop,
            "pendingClip": clip_snapshot(self.state.pending_clip),
            "archiveClips": [clip_snapshot(clip) for clip in valid_archives(self.state.song, self.state.archive_clips)],
            "blockedReason": self.state.blocked_reason,
        }

    def set_connection(self, connected: bool) -> None:
        self.state.connection = "connected" if connected else "disconnected"

    def _put(self, song: LiveSong, action: Action) -> Optional[str]:
        if self.state.transport == "recording":
            return "already_recording"
        if self.state.pending_clip is not None:
            return self._keep_pending(song)
        return self._start_recording(song)

    def _keep(self, song: LiveSong, action: Action) -> Optional[str]:
        end_error = self._end_active_pass(song)
        return end_error if end_error is not None else self._keep_pending(song)

    def _again(self, song: LiveSong, action: Action) -> Optional[str]:
        end_error = self._end_active_pass(song)
        if end_error is not None:
            return end_error
        pending_error = self._pending_error(song)
        if pending_error is not None:
            return pending_error
        marker = self.state.edit_marker
        self.state.pending_source.delete_clip(self.state.pending_clip)
        self.state.pending_clip = None
        self.state.pending_source = None
        self.state.edit_marker = marker
        song.current_song_time = marker
        return self._start_recording(song)

    def _hear(self, song: LiveSong, action: Action) -> Optional[str]:
        end_error = self._end_active_pass(song)
        if end_error is not None:
            return end_error
        song.record_mode = False
        song.current_song_time = self.state.edit_marker
        song.start_playing()
        self.state.transport = "playing"
        return None

    def _stop(self, song: LiveSong, action: Action) -> Optional[str]:
        end_error = self._end_active_pass(song)
        if end_error is not None:
            return end_error
        song.record_mode = False
        song.stop_playing()
        song.current_song_time = self.state.edit_marker
        self.state.transport = "stopped"
        return None

    def _seek(self, song: LiveSong, action: Action) -> Optional[str]:
        position = action.position_beats
        if self.state.transport == "recording":
            return "seek_while_recording"
        if position < 0.0:
            return "invalid_seek"
        self.state.edit_marker = position
        song.current_song_time = position
        return None

    def _start_recording(self, song: LiveSong) -> Optional[str]:
        target = record_target(song)
        return "no_armed_audio_track" if target is None else self._start_on(song, target)

    def _start_on(self, song: LiveSong, target: LiveTrack) -> Optional[str]:
        if not track_present(song, target):
            return "record_target_invalidated"
        song.stop_playing()
        song.current_song_time = self.state.edit_marker
        self.state.active_source = target
        self.state.pass_start = self.state.edit_marker
        self.state.clip_inventory = tuple(id(clip) for clip in target.arrangement_clips)
        song.record_mode = True
        song.start_playing()
        self.state.transport = "recording"
        return None

    def _end_active_pass(self, song: LiveSong) -> Optional[str]:
        if self.state.transport != "recording":
            return None if self.state.pending_clip is not None else "no_active_take"
        source = self.state.active_source
        stop = float(song.current_song_time)
        song.record_mode = False
        song.stop_playing()
        self.state.transport = "stopped"
        self.state.saved_stop = stop
        self.state.saved_bar = float(song.signature_numerator) * 4.0 / float(song.signature_denominator)
        if self.state.pass_start is not None:
            song.current_song_time = self.state.pass_start
        self.state.active_source = None
        if source is None or not track_present(song, source):
            return "source_track_invalidated"
        new_clips = [clip for clip in source.arrangement_clips if id(clip) not in self.state.clip_inventory]
        if len(new_clips) != 1 or not new_clips[0].is_audio_clip:
            return "ambiguous_recorded_clip"
        self.state.pending_source = source
        self.state.pending_clip = new_clips[0]
        return None

    def _keep_pending(self, song: LiveSong) -> Optional[str]:
        pending_error = self._pending_error(song)
        if pending_error is not None:
            return pending_error
        next_target = record_target(song)
        if next_target is None:
            return "no_armed_audio_track"
        source = self.state.pending_source
        clip = self.state.pending_clip
        source_index = track_index(song, source)
        destination, needs_clone = self._destination(song, next_target)
        prior_marker = self.state.edit_marker
        song.begin_undo_step()
        try:
            if needs_clone:
                song.duplicate_track(source_index)
                destination = song.tracks[source_index + 1]
                destination.name = source.name
                for copied_clip in list(destination.arrangement_clips):
                    destination.delete_clip(copied_clip)
                destination.arm = False
            before = tuple(id(existing) for existing in destination.arrangement_clips)
            destination.duplicate_clip_to_arrangement(clip, clip.start_time)
            created = [item for item in destination.arrangement_clips if id(item) not in before]
            if len(created) != 1:
                raise KeepMutationError("ambiguous destination clip")
            accepted = created[0]
            destination.arm = False
            source.delete_clip(clip)
            self.state.archive_clips.append(accepted)
            self.state.pending_clip = None
            self.state.pending_source = None
            self._advance_marker(song, clip)
            start_error = self._start_on(song, next_target)
            if start_error is not None:
                raise KeepMutationError(start_error)
        except RuntimeError:
            song.end_undo_step()
            song.undo()
            song.record_mode = False
            song.stop_playing()
            self.state.transport = "stopped"
            self.state.pending_clip = None
            self.state.pending_source = None
            self.state.edit_marker = prior_marker
            song.current_song_time = prior_marker
            return "keep_compensated"
        song.end_undo_step()
        return None

    def _advance_marker(self, song: LiveSong, clip: LiveClip) -> None:
        stop = self.state.saved_stop if self.state.saved_stop is not None else clip.end_time
        bar = self.state.saved_bar if self.state.saved_bar is not None else 4.0
        if stop - clip.start_time > bar:
            self.state.edit_marker = stop - bar
        song.current_song_time = self.state.edit_marker

    def _pending_error(self, song: LiveSong) -> Optional[str]:
        source = self.state.pending_source
        clip = self.state.pending_clip
        if source is None or not track_present(song, source):
            return "source_track_invalidated"
        occurrences = sum(1 for item in source.arrangement_clips if item is clip)
        return None if clip is not None and occurrences == 1 else "pending_clip_invalidated"

    def _destination(self, song: LiveSong, next_target: LiveTrack) -> Tuple[LiveTrack, bool]:
        source_index = track_index(song, self.state.pending_source)
        clip = self.state.pending_clip
        if source_index + 1 < len(song.tracks):
            lower = song.tracks[source_index + 1]
            writable = lower.has_audio_input and not lower.is_frozen
            overlaps = any(item.start_time < clip.end_time and clip.start_time < item.end_time for item in lower.arrangement_clips)
            if writable and not overlaps and lower is not next_target:
                return lower, False
        return song.tracks[source_index], True

    def _reject(self, request: Request, error: str, cache: bool) -> Response:
        response = Response(False, request.request_id, self.state.revision, error, self.snapshot())
        if cache:
            self._remember(response)
        return response

    def _remember(self, response: Response) -> None:
        if len(self._results) >= 256:
            self._results.pop(next(iter(self._results)))
        self._results[response.request_id] = response
