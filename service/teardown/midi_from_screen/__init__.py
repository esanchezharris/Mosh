"""§5 MIDI-from-screen — where a piano roll is visible, reconstruct note data → .mid (the
highest-fidelity MIDI source; producer of `deterministic` gold anchors). Generic CV core
(detect note rectangles given the pitch/time axes) + per-DAW skin profiles (gutter, grid,
note colours). The note-detection core is hermetically tested on synthetic rolls; axis
detection from real frames is the per-DAW-profile work (gated, needs real clips).
"""
from .axes import Axes  # noqa: F401
from .notes import detect_notes  # noqa: F401
from .export import write_midi  # noqa: F401
