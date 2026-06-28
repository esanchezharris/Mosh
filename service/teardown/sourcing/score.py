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


def predicted_from_skeleton(source: dict, meta_signals: dict) -> dict:
    """Best-effort §3 yield prediction from the signals §4 ALREADY has (source metadata + scan_meta),
    so a direct-URL teardown still carries a `yield.predicted` to validate §9's `yield.actual`
    against. Coarser than the scout's title-rich prediction (no chapters/captions/genre), but honest
    — metadata-only. Maps scan_meta's daw/plugins/pianoroll + a title heuristic into predict_yield."""
    ms = meta_signals or {}
    title = ((source or {}).get("title") or "").lower()
    is_tut = (any(k in title for k in ("tutorial", "how to", "how i", "make a", "sound design",
                                       "from scratch", "beat breakdown"))
              or bool(ms.get("pianoroll")) or bool(ms.get("plugins")))
    daw = ms.get("daw")
    sig = {
        "is_tutorial": is_tut,
        "daw": daw if daw and daw != "unknown" else None,
        "plugins": ms.get("plugins") or [],
        "has_chapters": False, "has_captions": False, "genre": None,
        "from_scratch": "from scratch" in title,
    }
    return predict_yield(sig, license=(source or {}).get("license", "unknown"))


_YIELD_FIELDS = ("drums", "midi", "synth", "arrangement", "overall")


def _yget(y, f: str) -> float:
    v = getattr(y, f, None) if not isinstance(y, dict) else (y or {}).get(f)
    try:
        return float(v) if v is not None else 0.0
    except (TypeError, ValueError):
        return 0.0


def validate_yield(predicted, actual, *, tol: float = 0.25, rendered: bool = True) -> dict:
    """Compare §3 `yield.predicted` against §9 `yield.actual` (each a YieldScores or dict) and make
    the comparison HONEST: a rosy metadata prediction the reconstruction failed to deliver
    (overall predicted − actual > tol) is flagged 'overconfident' so it can't pass silently as a
    success. Accepts either object or dict. status:
      unscored    — no prediction to validate against (source not §3-scored);
      unrendered  — `rendered` is False (recipe compiled but not executed → no actual to compare);
      overconfident — predicted overshot actual beyond `tol` on overall;
      calibrated  — predicted tracked actual within tol.
    CRITICAL: a render that RAN but produced nothing (actual all-zero, `rendered=True`) is the
    MAXIMAL overconfidence — predicted X, delivered 0 — and IS flagged, not waved through as
    'unrendered'. Only `rendered=False` (never executed) skips the comparison. Positive deltas =
    predicted overshot actual; `worst_field` is the biggest overshoot."""
    pred = {f: _yget(predicted, f) for f in _YIELD_FIELDS}
    act = {f: _yget(actual, f) for f in _YIELD_FIELDS}
    if not any(pred.values()):
        return {"status": "unscored", "overconfident": False,
                "reason": "no yield.predicted (source not §3-scored)"}
    if not rendered:
        return {"status": "unrendered", "overconfident": False,
                "reason": "recipe not executed (no render)", "predicted": pred}
    deltas = {f: round(pred[f] - act[f], 3) for f in _YIELD_FIELDS}
    over = deltas["overall"] > tol
    return {"status": "overconfident" if over else "calibrated", "overconfident": over,
            "overall_delta": deltas["overall"],
            "worst_field": max(_YIELD_FIELDS, key=lambda f: deltas[f]),
            "predicted": pred, "actual": act, "deltas": deltas}
