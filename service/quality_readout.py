"""quality_readout.py — heuristic DSP quality readout for rendered audio (judge v0).

The spec's judge panel (CLAP + MuQ-MuLan + Audiobox-Aesthetics + MERT-FAD; 05 §7)
exposes a `pq` production-quality signal + `flags` on every render. That panel is a
heavy, separately-versioned stack (audiobox-aesthetics needs a torchaudio matched to
the venv's torch — risky on bleeding-edge cu130). So v0 ships a TRANSPARENT DSP proxy:
signal-hygiene metrics (loudness, clipping, dynamics, spectral balance, phase, silence)
folded into a `pq` in [0,10] (Audiobox-like scale) + human-readable `flags`.

This is a HEURISTIC readout, NOT a learned aesthetic model — it measures signal hygiene,
not musicality/timbre/prompt-adherence. The UI labels it "DSP readout (heuristic)". A
learned judge can later override `pq` behind MOSH_JUDGE (a separate judge venv) while
keeping these flags.

Deps: numpy + soundfile ONLY (both already in the SA3 venv). Pure-CPU, <50 ms on a
few-second clip — safe to run inline in the job service without touching torch/GPU.
"""
from __future__ import annotations

# numpy + soundfile are needed ONLY by analyze_wav() (the signal-hygiene path). judge_reasoning()
# is pure-python (no deps), and the stdlib-only FakeAdapter calls ONLY judge_reasoning — so guard
# these imports: server.py imports fake_adapter (→ quality_readout) unconditionally at boot, and the
# FakeAdapter must stay reachable with ZERO install (a prime-directive graceful-degradation fallback).
# analyze_wav raises a clear error if called without them (only the real-judge path, which always has
# the SA3 venv, ever calls it).
try:
    import numpy as np
    import soundfile as sf
except ImportError:  # pragma: no cover - exercised only in the minimal FakeAdapter environment
    np = None
    sf = None

EPS = 1e-12


def _db(v: float) -> float:
    return 20.0 * np.log10(max(float(v), EPS))


def _clamp(v: float, lo: float = 0.0, hi: float = 1.0) -> float:
    return max(lo, min(hi, v))


# Audiobox-Aesthetics axes (10-point scale): production quality, content enjoyment,
# content usefulness, production complexity. The judge sidecar reports these; this maps
# each to a short clause so the drawer can show *why* the score is what it is (AL-006).
_AXIS_LABEL = {
    "PQ": "production quality",
    "CE": "enjoyment",
    "CU": "usefulness",
    "PC": "complexity",
}


def _grade(v: float) -> str:
    """One-word verdict for a 0–10 aesthetic score."""
    if v >= 7.5:
        return "strong"
    if v >= 6.0:
        return "good"
    if v >= 4.0:
        return "fair"
    return "weak"


def judge_reasoning(axes=None, flags=None) -> str:
    """Synthesize the judge's one-line reasoning from its aesthetic axes + flags.

    Pure + dependency-free so it is shared by the real Audiobox path (sa3/qa.py) and the
    fake adapter, and unit-tested directly. `axes` is the Audiobox dict (PQ/CE/CU/PC on a
    0–10 scale); any subset is fine and `None` is tolerated. `flags` are the human-readable
    hygiene warnings (e.g. "clipping: …"); their leading token is appended so the listener
    sees the concrete reason a score is low. Always returns a usable sentence."""
    axes = axes or {}
    flags = flags or []
    parts = []

    pq = axes.get("PQ")
    if pq is not None:
        parts.append(f"{_grade(float(pq)).capitalize()} production quality ({float(pq):.1f}/10)")
        # Add the most salient secondary axis (the lowest-scoring of CE/CU/PC) as colour.
        secondary = [(k, float(axes[k])) for k in ("CE", "CU", "PC") if axes.get(k) is not None]
        if secondary:
            worst_k, worst_v = min(secondary, key=lambda kv: kv[1])
            parts.append(f"{_grade(worst_v)} {_AXIS_LABEL.get(worst_k, worst_k.lower())}")

    if flags:
        # Surface the flag *names* (the token before the colon) — e.g. "clipping", "muddy".
        names = [str(f).split(":", 1)[0].strip() for f in flags if str(f).strip()]
        names = [n for n in names if n]
        if names:
            parts.append("flagged: " + ", ".join(names))

    if not parts:
        return "No judge readout available."
    return "; ".join(parts) + "."


def analyze_wav(path: str) -> dict:
    """Return {pq: float[0,10], metrics: {...}, flags: [str, ...]} for a WAV file."""
    if np is None or sf is None:
        raise RuntimeError("quality_readout.analyze_wav needs numpy + soundfile (install the SA3 venv)")
    x, sr = sf.read(path, always_2d=True, dtype="float64")  # [n, ch]
    return analyze_array(x, sr)


def analyze_array(x, sr: int) -> dict:
    """Same as analyze_wav but on an in-memory array [n, ch] (or [n]) — lets callers
    score a source region (pq_base) without a temp file."""
    x = np.asarray(x, dtype="float64")
    if x.ndim == 1:
        x = x[:, None]
    n, ch = x.shape
    if n == 0:
        return {"pq": 0.0, "metrics": {}, "flags": ["empty: no samples"]}
    mono = x.mean(axis=1)

    # ── levels ──
    sample_peak = float(np.max(np.abs(x)))
    peak_dbfs = _db(sample_peak)
    rms = float(np.sqrt(np.mean(mono ** 2) + EPS))
    rms_dbfs = _db(rms)
    crest_db = _db(sample_peak / max(rms, EPS))
    dc = float(np.mean(mono))

    # longest full-scale run (clip detector)
    full = np.abs(x).max(axis=1) >= 0.9995
    run = best = 0
    for f in full:
        run = run + 1 if f else 0
        if run > best:
            best = run

    # ── spectrum (single Hann frame, ≤16384 samples ≈ 0.37 s @ 44.1k) ──
    N = int(min(n, 16384))
    win = np.hanning(N) if N > 1 else np.ones(1)
    S = np.abs(np.fft.rfft(mono[:N] * win)) + EPS
    freqs = np.fft.rfftfreq(N, 1.0 / sr)
    centroid = float(np.sum(freqs * S) / np.sum(S))
    cum = np.cumsum(S)
    ridx = int(np.searchsorted(cum, 0.85 * cum[-1]))
    rolloff = float(freqs[min(ridx, len(freqs) - 1)])

    # ── stereo ──
    if ch >= 2:
        l, r = x[:, 0], x[:, 1]
        corr = float(np.sum(l * r) / (np.sqrt(np.sum(l ** 2) * np.sum(r ** 2)) + EPS))
    else:
        corr = 1.0

    # ── silence / dropout ──
    fl = 2048
    nf = max(1, n // fl)
    fr = mono[:nf * fl].reshape(nf, fl)
    fdb = 20.0 * np.log10(np.maximum(np.sqrt(np.mean(fr ** 2, axis=1)), EPS))
    silent = fdb < -50.0
    silence_ratio = float(np.mean(silent))
    dropout = False
    if nf >= 3:
        loud = ~silent
        for i in range(1, nf - 1):
            if silent[i] and loud[i - 1] and loud[i + 1]:
                dropout = True
                break

    metrics = {
        "sr": sr, "channels": ch, "samples": n,
        "peak_dbfs": round(peak_dbfs, 2), "rms_dbfs": round(rms_dbfs, 2),
        "lufs_approx": round(rms_dbfs, 2), "crest_db": round(crest_db, 2),
        "dc_offset": round(dc, 5), "clip_run": int(best),
        "centroid_hz": round(centroid, 1), "rolloff85_hz": round(rolloff, 1),
        "stereo_corr": round(corr, 3), "silence_ratio": round(silence_ratio, 3),
    }

    # ── flags ──
    flags = []
    if peak_dbfs >= -0.1 or best >= 3:
        flags.append(f"clipping: peak {peak_dbfs:.2f} dBFS ({best} samples at full scale)")
    if rms_dbfs < -40:
        flags.append(f"too_quiet: level {rms_dbfs:.1f} dBFS (< -40)")
    if silence_ratio > 0.95:
        flags.append(f"near_silent: {silence_ratio * 100:.0f}% frames < -50 dBFS")
    if abs(dc) > 0.01:
        flags.append(f"dc_offset: {dc:+.3f} (> 0.01)")
    if crest_db < 3.0:
        flags.append(f"over_compressed: crest {crest_db:.1f} dB (< 3)")
    if centroid > 6000 and rms_dbfs > -45:
        flags.append(f"harsh: centroid {centroid:.0f} Hz")
    if rolloff < 1500 and silence_ratio < 0.5:
        flags.append(f"muddy: 85% rolloff {rolloff:.0f} Hz")
    if corr < 0:
        flags.append(f"out_of_phase: stereo corr {corr:.2f} (< 0)")
    if dropout:
        flags.append("dropout: silent gap mid-signal")

    # ── pq in [0,10] (soft sub-scores summing to 10) ──
    s_loud = _clamp(1 - abs(rms_dbfs - (-14)) / 14)          # peaks at -14 dBFS
    s_head = _clamp(1 - max(0.0, peak_dbfs + 1.0) / 0.9)     # full if peak<=-1, 0 at -0.1
    s_dyn = _clamp((crest_db - 3) / (12 - 3))                # 0 at 3 dB, full at >=12
    s_cent = _clamp(1 - abs(np.log2(max(centroid, EPS) / 1800)) / 2)
    s_clean = 1 - min(1.0, 0.5 * (abs(dc) > 0.01) + 0.5 * (corr < 0) + 0.5 * (silence_ratio > 0.95))
    pq = 3.0 * s_loud + 2.0 * s_head + 2.0 * s_dyn + 1.5 * s_cent + 1.5 * s_clean
    pq = _clamp(pq, 0.0, 10.0)

    # hard caps — a broken render never scores "good"
    if any(f.startswith("clipping") for f in flags):
        pq = min(pq, 4.0)
    if silence_ratio > 0.95:
        pq = min(pq, 1.0)
    if corr < 0:
        pq = min(pq, 5.0)
    pq = round(pq, 2)

    return {"pq": pq, "metrics": metrics, "flags": flags}
