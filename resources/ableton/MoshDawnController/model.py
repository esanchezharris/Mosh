"""Typed protocol and session values shared by the controller."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple, Union


JsonScalar = Union[str, int, float, bool, None]
JsonValue = Union[JsonScalar, List["JsonValue"], Dict[str, "JsonValue"]]


@dataclass(frozen=True)  # noqa: SLOTS_OK - Live 11 embeds Python 3.7.
class Put:
    pass


@dataclass(frozen=True)  # noqa: SLOTS_OK - Live 11 embeds Python 3.7.
class Keep:
    pass


@dataclass(frozen=True)  # noqa: SLOTS_OK - Live 11 embeds Python 3.7.
class Again:
    pass


@dataclass(frozen=True)  # noqa: SLOTS_OK - Live 11 embeds Python 3.7.
class Hear:
    pass


@dataclass(frozen=True)  # noqa: SLOTS_OK - Live 11 embeds Python 3.7.
class Stop:
    pass


@dataclass(frozen=True)  # noqa: SLOTS_OK - Live 11 embeds Python 3.7.
class Seek:
    position_beats: float


Action = Union[Put, Keep, Again, Hear, Stop, Seek]


@dataclass(frozen=True)  # noqa: SLOTS_OK - Live 11 embeds Python 3.7.
class Request:
    request_id: str
    expected_revision: int
    action: Action


@dataclass  # noqa: MUTABLE_OK # noqa: SLOTS_OK - mutable state machine on Live 11 Python 3.7.
class SessionState:
    """Mutable state machine owned by one Live Remote Script lifecycle."""

    song: "LiveSong"
    revision: int = 0
    connection: str = "disconnected"
    transport: str = "stopped"
    edit_marker: float = 0.0
    active_source: Optional["LiveTrack"] = None
    pass_start: Optional[float] = None
    saved_stop: Optional[float] = None
    saved_bar: Optional[float] = None
    pending_source: Optional["LiveTrack"] = None
    pending_clip: Optional["LiveClip"] = None
    clip_inventory: Tuple[int, ...] = ()
    archive_clips: List["LiveClip"] = field(default_factory=list)
    blocked_reason: Optional[str] = None
    ownership_uncertain: bool = False


@dataclass(frozen=True)  # noqa: SLOTS_OK - Live 11 embeds Python 3.7.
class Response:
    ok: bool
    request_id: str
    revision: int
    error: Optional[str]
    state: Dict[str, JsonValue]


class LiveClip:
    """Subset of an arrangement audio clip used by the controller."""

    start_time: float
    end_time: float
    name: str
    is_audio_clip: bool


class LiveTrack:
    """Subset of a Live track used by the controller."""

    name: str
    arm: bool
    has_audio_input: bool
    can_be_armed: bool
    is_frozen: bool
    arrangement_clips: List[LiveClip]
    clip_slots: List["LiveClipSlot"]

    def delete_clip(self, clip: LiveClip) -> None:
        raise NotImplementedError

    def duplicate_clip_to_arrangement(self, clip: LiveClip, position: float) -> None:
        raise NotImplementedError


class LiveClipSlot:
    """Subset of a Session View clip slot copied by track duplication."""

    has_clip: bool

    def delete_clip(self) -> None:
        raise NotImplementedError


class LiveSong:
    """Subset of Live's Song API used by the semantic action engine."""

    tracks: List[LiveTrack]
    current_song_time: float
    record_mode: bool
    is_playing: bool
    signature_numerator: int
    signature_denominator: int

    def start_playing(self) -> None:
        raise NotImplementedError

    def stop_playing(self) -> None:
        raise NotImplementedError

    def begin_undo_step(self) -> None:
        raise NotImplementedError

    def end_undo_step(self) -> None:
        raise NotImplementedError

    def undo(self) -> None:
        raise NotImplementedError

    def duplicate_track(self, index: int) -> None:
        raise NotImplementedError


class LiveCInstance:
    """Live host handle supplied to ``create_instance``."""

    def song(self) -> LiveSong:
        raise NotImplementedError
