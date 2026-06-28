"""Recipe-yield prediction — aggregate prescreen signals into yield.predicted per field
(drums/midi/synth/arrangement/overall, each 0–1), so §10 pulls the richest tutorials
first. v1 is metadata-only; §3's sparse visual verify (needs §2) and §9's actual yield
refine it later. CC sources get a small overall nudge (posture).
"""
from __future__ import annotations

from .posture import cc_rank_boost


def _c(x: float) -> float:
    return round(max(0.0, min(1.0, x)), 3)


def predict_yield(signals: dict, license: str = "unknown") -> dict:
    is_tut = signals.get("is_tutorial", False)
    daw = signals.get("daw")
    plugins = signals.get("plugins", []) or []
    chapters = signals.get("has_chapters", False)
    captions = signals.get("has_captions", False)
    genre = signals.get("genre")
    from_scratch = signals.get("from_scratch", False)

    base = 0.5 if is_tut else 0.1
    drums = _c(base + 0.20 * (genre is not None) + 0.10 * from_scratch)
    midi = _c(base + 0.15 * (daw is not None) + 0.10 * chapters)        # piano-roll likelier when a DAW is shown
    synth = _c(base + 0.06 * len(plugins))                              # named plugins → recoverable patches
    arrangement = _c(base + 0.20 * chapters + 0.10 * captions)          # chapters/timestamps → section structure
    overall = _c(0.40 * drums + 0.25 * midi + 0.20 * synth + 0.15 * arrangement + cc_rank_boost(license))
    return {"drums": drums, "midi": midi, "synth": synth, "arrangement": arrangement, "overall": overall}
