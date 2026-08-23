"""Pure identity and snapshot helpers for the Live Set topology."""

from __future__ import annotations

from typing import List, Optional

from .model import JsonValue, LiveClip, LiveSong, LiveTrack


def record_target(song: LiveSong) -> Optional[LiveTrack]:
    return next(
        (track for track in song.tracks if track.has_audio_input and track.can_be_armed and track.arm),
        None,
    )


def track_present(song: LiveSong, track: LiveTrack) -> bool:
    return sum(1 for item in song.tracks if item is track) == 1


def track_index(song: LiveSong, track: LiveTrack) -> int:
    return next(index for index, item in enumerate(song.tracks) if item is track)


def valid_archives(song: LiveSong, archives: List[LiveClip]) -> List[LiveClip]:
    clips = [clip for track in song.tracks for clip in track.arrangement_clips]
    return [archive for archive in archives if any(clip is archive for clip in clips)]


def track_snapshot(track: Optional[LiveTrack]) -> JsonValue:
    return None if track is None else {"id": str(id(track)), "name": track.name}


def clip_snapshot(clip: Optional[LiveClip]) -> JsonValue:
    if clip is None:
        return None
    return {
        "id": str(id(clip)),
        "name": clip.name,
        "startBeats": clip.start_time,
        "endBeats": clip.end_time,
    }
