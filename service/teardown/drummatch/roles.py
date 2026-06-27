"""Cheap, deterministic role guesser (kick/808/snare/hat/clap/perc/other) for role-filtered
queries, the index manifest, and §7 slice labels. Rule-based on robust BAND-ENERGY
descriptors — not a trained model; it narrows candidates, it doesn't have to be perfect.
The Recipe's `role` enum (§0) is the controlled vocabulary; this returns a subset of it.

Why band energies (not a single centroid): sliced loop hits OVERLAP — a downbeat is
kick+hat, a backbeat is snare+hat, and the previous hit's tail bleeds in. A single spectral
centroid smears those mixtures to mid-range and the old rule dumped them all to "other".
Energy *fractions per band* are robust to that smearing: a kick+hat mix still has strong
sub-bass AND strong highs, so we read it by the foundational low end (it IS the kick at that
beat). Two more robustness moves: (1) classify on the ATTACK window (first ~120 ms) where
the new transient dominates the bleed, and (2) a dominant-band FALLBACK so a hit is only
"other" when it's genuinely degenerate (silent), never just because it's a mixture.
"""
from __future__ import annotations

import numpy as np

# subset of recipe.Role values this heuristic emits. "808" splits off the sustained,
# pitched low end (vs the punchy short kick) — the gap that left 808s scattered across
# kick/perc/other on real libraries.
ROLE_VALUES = ("kick", "808", "snare", "hat", "clap", "perc", "other")


def _band_features(y: np.ndarray, sr: int) -> dict:
    """Power fractions per frequency band + flatness/zcr/centroid, computed on the attack
    window. numpy-only (no librosa) → deterministic and robust on tiny/odd-length slices."""
    head_n = max(256, int(0.12 * sr))
    head = y[:head_n] if y.size > head_n else y
    n = len(head)
    if n < 8:
        return {}
    win = np.hanning(n).astype(np.float32)
    nfft = 1 << int(np.ceil(np.log2(max(512, n))))
    spec = np.abs(np.fft.rfft(head * win, n=nfft))
    power = (spec * spec).astype(np.float64)
    freqs = np.fft.rfftfreq(nfft, 1.0 / sr)
    total = float(power.sum())
    if total <= 1e-12:
        return {}

    def frac(lo: float, hi: float) -> float:
        return float(power[(freqs >= lo) & (freqs < hi)].sum()) / total

    nyq = sr / 2.0
    sub, low = frac(20.0, 120.0), frac(120.0, 250.0)
    lowmid, mid = frac(250.0, 800.0), frac(800.0, 2500.0)
    high, vhigh = frac(2500.0, 8000.0), frac(8000.0, nyq)

    pos = power[power > 0]
    flatness = float(np.exp(np.mean(np.log(pos))) / (np.mean(power) + 1e-18)) if pos.size else 0.0
    centroid = float((freqs * power).sum() / total)
    sign = np.signbit(head).astype(np.int8)
    zcr = float(np.count_nonzero(np.diff(sign))) / max(1, n - 1)

    return {
        "sub": sub, "low": low, "lowmid": lowmid, "mid": mid, "high": high, "vhigh": vhigh,
        "low_tot": sub + low, "mid_tot": lowmid + mid, "hi_tot": high + vhigh,
        "flatness": flatness, "centroid": centroid, "zcr": zcr,
    }


def classify_role(y: np.ndarray, sr: int) -> str:
    """Guess a drum role from per-band energy fractions on the onset transient. Designed so
    overlapping loop hits classify by their foundational content (kick+hat → kick) instead of
    collapsing to "other"; only a degenerate (silent/too-short) slice returns "other"."""
    y = np.asarray(y, dtype=np.float32)
    if y.size == 0:
        return "other"

    dur = len(y) / float(sr)
    f = _band_features(y, sr)
    if not f:
        return "other"

    sub, low, lowmid = f["sub"], f["low"], f["lowmid"]
    mid, high, vhigh = f["mid"], f["high"], f["vhigh"]
    low_tot, mid_tot, hi_tot = f["low_tot"], f["mid_tot"], f["hi_tot"]
    flat = f["flatness"]

    # sustain ratio = late-body RMS (0.3–0.6 s) / early RMS (0–0.1 s). An 808 RINGS OUT (its
    # pitched sub sustains → ratio stays high); a kick punches then decays (ratio collapses).
    # This beats a raw-duration cliff: real kick one-shot FILES carry decay tails past 0.4 s
    # and would otherwise all mis-read as 808 (the cause of 808≫kick on real libraries).
    early = y[: int(0.10 * sr)]
    late = y[int(0.30 * sr): int(0.60 * sr)]
    e_rms = float(np.sqrt(np.mean(early * early))) if early.size else 0.0
    l_rms = float(np.sqrt(np.mean(late * late))) if late.size else 0.0
    sustain = (l_rms / e_rms) if e_rms > 1e-6 else 0.0

    def kick_or_808() -> str:
        # the sustained, spectrally-peaky low tone is an 808; the punchy decaying one a kick.
        return "808" if (dur >= 0.40 and sustain >= 0.30 and flat <= 0.32) else "kick"

    # 1) hi-hat / cymbal — bright AND high-DOMINANT AND no real low end. The dominance test
    #    (hi_tot ≥ mid_tot) keeps mid-heavy bright sounds (claps, rimshots) out of "hat".
    if hi_tot >= 0.40 and hi_tot >= mid_tot and low_tot < 0.15:
        return "hat"

    # 2) kick / 808 — a genuine SUB-bass foundation (20–120 Hz). Gating on `sub` (not the
    #    whole 20–250 Hz low band) is the fix that stops a snare's 120–250 Hz shell tone from
    #    masquerading as a kick (real snares carry their fundamental there with little sub).
    #    A loud kick layered under a hat/snare still dominates the sub band → mixtures read as
    #    kick (the foundational hit of that beat), which is what we want.
    if sub >= 0.25 or (sub >= 0.18 and sub >= low and sub >= mid and sub >= high and sub >= vhigh):
        return kick_or_808()

    # 3) body family — snare / clap / perc (mid/high content, no deep sub).
    if hi_tot >= 0.18:                         # carries broadband noise/air → snare or clap
        return "clap" if flat >= 0.22 else "snare"   # claps are noisier/flatter than a tuned snare
    if mid_tot >= 0.18 or lowmid >= 0.18:      # tonal mid, little noise → toms / rim / bells
        return "perc"

    # 4) leftover low-ish energy not sub-heavy enough for a clean kick call, but low-dominant.
    if low_tot >= mid_tot and low_tot >= hi_tot and low_tot > 0.0:
        return kick_or_808()

    # 5) dominant-band fallback — never dump a real hit to "other" just because it's a
    #    mixture; only a degenerate (silent) slice reaches "other".
    groups = {"low": low_tot, "mid": mid_tot, "hi": hi_tot}
    dom = max(groups, key=groups.get)
    if groups[dom] <= 0.0:
        return "other"
    return {"low": kick_or_808(), "hi": "hat", "mid": "snare"}[dom]
