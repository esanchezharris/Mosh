"""§7 Audio extraction & isolation lane (regime-3 + audio→MIDI fallback).

The honest hard lane — used when the screen DOESN'T hand you the info. Everything here is
lossy and confidence-tagged below §5's screen-read fidelity, and its outputs are tagged
`inferred` (never gold anchors). Separation (demucs) is gated on the dep; the slicing,
mono-pitch→MIDI, and mono-tone isolation cores run on librosa (no heavy install) and are
hermetically tested. Drum slices round-trip through §1 to reference samples the owner owns.
"""
from .separate import DemucsSeparator, Separator  # noqa: F401
from .drum_slice import Slice, slice_oneshots  # noqa: F401
from .pitch import mono_to_midi  # noqa: F401
from .mono_tone import isolate_mono_tone  # noqa: F401
