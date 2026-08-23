"""Identity recovery and safe snapshots for the Live Set topology."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple

from .model import JsonValue, LiveClip, LiveSong, LiveTrack, SessionState


@dataclass(frozen=True)  # noqa: SLOTS_OK - Live 11 embeds Python 3.7.
class PendingFingerprint:
    source_identity: int
    source_index: int
    source_name: str
    clip_identity: int
    clip_start: float
    clip_end: float
    clip_name: str


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


def pending_fingerprint(song: LiveSong, source: LiveTrack, clip: LiveClip) -> PendingFingerprint:
    return PendingFingerprint(
        id(source), track_index(song, source), source.name, id(clip),
        clip.start_time, clip.end_time, clip.name,
    )


def resolve_pending(song: LiveSong, fingerprint: PendingFingerprint) -> Optional[Tuple[LiveTrack, LiveClip]]:
    identity_sources = [track for track in song.tracks if id(track) == fingerprint.source_identity]
    if len(identity_sources) == 1:
        source = identity_sources[0]
    elif fingerprint.source_index < len(song.tracks):
        indexed = song.tracks[fingerprint.source_index]
        if indexed.name != fingerprint.source_name:
            return None
        source = indexed
    else:
        return None
    identity_clips = [clip for clip in source.arrangement_clips if id(clip) == fingerprint.clip_identity]
    if len(identity_clips) == 1:
        return source, identity_clips[0]
    matches = [
        clip for clip in source.arrangement_clips
        if clip.is_audio_clip
        and clip.start_time == fingerprint.clip_start
        and clip.end_time == fingerprint.clip_end
        and clip.name == fingerprint.clip_name
    ]
    return (source, matches[0]) if len(matches) == 1 else None


def session_snapshot(state: SessionState) -> Dict[str, JsonValue]:
    pending_source = state.pending_source
    pending_clip = state.pending_clip
    pending_valid = (
        pending_source is not None
        and pending_clip is not None
        and track_present(state.song, pending_source)
        and sum(1 for clip in pending_source.arrangement_clips if clip is pending_clip) == 1
    )
    if (pending_source is not None or pending_clip is not None) and not pending_valid:
        state.pending_source = None
        state.pending_clip = None
        state.ownership_uncertain = True
        if state.blocked_reason is None:
            state.blocked_reason = "pending_ownership_uncertain"
    active = state.active_source
    if active is not None and not track_present(state.song, active):
        state.active_source = None
        state.ownership_uncertain = True
        if state.blocked_reason is None:
            state.blocked_reason = "source_track_invalidated"
        active = None
    source = pending_source if pending_valid else active
    return {
        "revision": state.revision,
        "connection": state.connection,
        "transport": state.transport,
        "editMarkerBeats": state.edit_marker,
        "activeSource": track_snapshot(source),
        "passStartBeats": state.pass_start,
        "savedStopBeats": state.saved_stop,
        "pendingClip": clip_snapshot(pending_clip if pending_valid else None),
        "archiveClips": [clip_snapshot(clip) for clip in valid_archives(state.song, state.archive_clips)],
        "blockedReason": state.blocked_reason,
        "ownershipUncertain": state.ownership_uncertain,
    }
