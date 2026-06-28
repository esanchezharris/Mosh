"""Substitute path — for unavailable / sample-based plugins (no params to recover): run the
same perceptual objective over a preset search space (patches of a synth the owner DOES own,
e.g. Vital) → the nearest achievable approximation. status=substituted, note='approximation'.
"""
from __future__ import annotations

from typing import Optional


def substitute(target, renderer, scorer, presets: list[dict]) -> Optional[dict]:
    """Pick the preset whose render is perceptually nearest the target tone. `presets` is a
    list of param dicts (each renderable by `renderer`). Returns the best or None."""
    best = None
    for i, p in enumerate(presets):
        y, sr = renderer.render(p)
        d = scorer.score((y, sr), target)
        if best is None or d < best["distance"]:
            best = {"preset_index": i, "params": p, "distance": round(float(d), 5)}
    return best
