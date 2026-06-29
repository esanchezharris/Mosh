#!/usr/bin/env python3
"""oracle.py — multi-objective render-and-compare reward for the prompt compiler (L2).

    reward = w_align·align + w_preserve·preserve + w_quality·quality

This is the measurement substrate that makes "is the compiler good?" answerable and (later)
feeds SFT/DPO/GRPO. v1 ships TWO terms with NO new model dependency:

  • quality  — signal hygiene via quality_readout.analyze_array (pq 0–10 → 0–1).
  • preserve — how much of the on-track take survives: a cheap log-band spectral cosine +
    a peak/rms/centroid feature similarity (NO learned embedding).
  • align    — CLAP text↔audio similarity (the research's "intent realized" term) is the ONE
    genuinely-new model dep. It is STUBBED (None) in v1 and slots in later as an isolated-
    venv sidecar mirroring sa3/judge_sidecar.py; when None, the reward renormalizes over the
    present terms so the weighting stays honest.

Intent-conditioned weights (the research's starting points):
  reimagine → align .6, preserve .1, quality .3   (realize the new intent; preserve little)
  transform → align .2, preserve .6, quality .2   (keep the take; change the timbre)

Reward-hacking guardrails, made concrete (the research's traps):
  • a SILENCE / NO-OP sentinel — a render that ≈ the input (the "preserve = do nothing" hack)
    or that is ≈ silent gets its reward floored, so the policy can't game preserve by
    doing nothing.
  • multi-term by construction — never a single-term reward.

The rewards.jsonl line shape matches the documented MOSH_RL_REWARD=audio seam so a future
GRPO loop reads it unchanged. numpy + stdlib `wave` only (soundfile NOT required).
"""
from __future__ import annotations

import json
import os
import sys
import wave
from typing import Dict, List, Optional, Tuple

import numpy as np

# Reuse the existing DSP quality readout (service/quality_readout.py) for the quality term.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # service/
import quality_readout  # noqa: E402

# (align, preserve, quality) weights per intent class. align is realized later (CLAP).
WEIGHTS: Dict[str, Tuple[float, float, float]] = {
    "reimagine": (0.6, 0.1, 0.3),
    "transform": (0.2, 0.6, 0.2),
    # corrective/fix would be (0.2, 0.6, 0.2) too — generative-only v1 never routes here.
}
_DEFAULT_WEIGHTS = (0.4, 0.3, 0.3)

_EPS = 1e-12
_SILENCE_RMS = 1.0e-3       # below this the render is effectively silent (broken)
_NOOP_DIFF = 8.0e-3         # diff-RMS below this ⇒ the render barely changed the input


# ── WAV loading (stdlib wave → mono float ndarray) ────────────────────────────────

def load_mono(path: str) -> Tuple[np.ndarray, int]:
    with wave.open(str(path), "rb") as w:
        nframes, ch, sr, sw = w.getnframes(), w.getnchannels(), w.getframerate(), w.getsampwidth()
        raw = w.readframes(nframes)
    if sw == 2:
        data = np.frombuffer(raw, dtype="<i2").astype(np.float64) / 32768.0
    elif sw == 3:
        b = np.frombuffer(raw, dtype=np.uint8).reshape(-1, 3).astype(np.int32)
        v = b[:, 0] | (b[:, 1] << 8) | (b[:, 2] << 16)
        v = np.where(v & 0x800000, v - 0x1000000, v)
        data = v.astype(np.float64) / 8388608.0
    elif sw == 4:
        data = np.frombuffer(raw, dtype="<i4").astype(np.float64) / 2147483648.0
    else:
        raise ValueError(f"unsupported sample width {sw} bytes")
    if ch > 1:
        data = data.reshape(-1, ch).mean(axis=1)
    return data, sr


# ── feature helpers ───────────────────────────────────────────────────────────────

def _rms(x: np.ndarray) -> float:
    return float(np.sqrt(np.mean(x ** 2) + _EPS)) if x.size else 0.0


def _centroid(x: np.ndarray, sr: int) -> float:
    if x.size < 2 or not sr:
        return 0.0
    spec = np.abs(np.fft.rfft(x * np.hanning(x.size))) + _EPS
    freqs = np.fft.rfftfreq(x.size, 1.0 / sr)
    return float((freqs * spec).sum() / spec.sum())


def _log_bands(x: np.ndarray, sr: int, nbands: int = 24) -> np.ndarray:
    """Log-spaced band energies (a cheap mel-ish spectral signature for cosine compare)."""
    if x.size < 4 or not sr:
        return np.zeros(nbands)
    n = int(min(x.size, 32768))
    spec = np.abs(np.fft.rfft(x[:n] * np.hanning(n)))
    freqs = np.fft.rfftfreq(n, 1.0 / sr)
    edges = np.logspace(np.log10(40.0), np.log10(max(sr / 2.0, 80.0)), nbands + 1)
    out = np.zeros(nbands)
    for i in range(nbands):
        m = (freqs >= edges[i]) & (freqs < edges[i + 1])
        out[i] = spec[m].sum()
    return np.log1p(out)


def _cosine(a: np.ndarray, b: np.ndarray) -> float:
    na, nb = float(np.linalg.norm(a)), float(np.linalg.norm(b))
    if na < _EPS or nb < _EPS:
        return 0.0
    return float(np.dot(a, b) / (na * nb))


# ── the three terms ────────────────────────────────────────────────────────────────

def quality_term(mono: np.ndarray, sr: int) -> float:
    """Signal-hygiene pq (0–10) → 0–1, via the existing DSP readout."""
    try:
        pq = quality_readout.analyze_array(mono, sr).get("pq", 0.0)
    except Exception:  # noqa: BLE001 — never let a scorer crash the loop
        pq = 0.0
    return max(0.0, min(1.0, float(pq) / 10.0))


def preserve_term(render: np.ndarray, src: np.ndarray, sr: int) -> float:
    """How much of the source take survives — log-band spectral cosine (0.7) + a
    peak/rms/centroid feature similarity (0.3). 1.0 = indistinguishable from the source."""
    n = int(min(render.size, src.size))
    if n == 0:
        return 0.0
    r, s = render[:n], src[:n]
    spec = max(0.0, _cosine(_log_bands(r, sr), _log_bands(s, sr)))
    # feature similarity (peak, rms, centroid) — normalized, bounded
    pr, ps = float(np.max(np.abs(r)) + _EPS), float(np.max(np.abs(s)) + _EPS)
    peak_sim = 1.0 - min(1.0, abs(pr - ps) / max(pr, ps))
    rr, rs = _rms(r) + _EPS, _rms(s) + _EPS
    rms_sim = 1.0 - min(1.0, abs(rr - rs) / max(rr, rs))
    cr, cs = _centroid(r, sr) + _EPS, _centroid(s, sr) + _EPS
    cent_sim = 1.0 - min(1.0, abs(np.log2(cr / cs)) / 3.0)
    feat = (peak_sim + rms_sim + cent_sim) / 3.0
    return max(0.0, min(1.0, 0.7 * spec + 0.3 * feat))


def _sentinel(render: np.ndarray, src: np.ndarray, sr: int) -> List[str]:
    """Concrete reward-hacking guards: a near-silent render, or a no-op that barely
    changed the input (the "preserve = do nothing" exploit)."""
    flags: List[str] = []
    if _rms(render) < _SILENCE_RMS:
        flags.append("silent")
    n = int(min(render.size, src.size))
    if n > 0:
        diff = float(np.sqrt(np.mean((render[:n] - src[:n]) ** 2) + _EPS))
        if diff < _NOOP_DIFF:
            flags.append("noop")
    return flags


# ── the reward ───────────────────────────────────────────────────────────────────

def score_arrays(render: np.ndarray, src: np.ndarray, sr: int, intent: str = "reimagine",
                 align: Optional[float] = None) -> dict:
    """Core (hermetic): score in-memory mono arrays. `align` (CLAP) is None in v1 — the
    weighting then renormalizes over the present {preserve, quality} terms."""
    q = quality_term(render, sr)
    p = preserve_term(render, src, sr)
    wa, wp, wq = WEIGHTS.get(intent, _DEFAULT_WEIGHTS)

    present = [(wp, p), (wq, q)]
    if align is not None:
        present.append((wa, max(0.0, min(1.0, float(align)))))
    wsum = sum(w for w, _ in present) or 1.0
    reward = sum((w / wsum) * v for w, v in present)

    flags = _sentinel(render, src, sr)
    if "silent" in flags:
        reward = min(reward, 0.02)        # a broken render can never score well
    if "noop" in flags:
        reward = min(reward, 0.10)        # doing nothing is not a valid generative edit

    return {
        "reward": round(float(reward), 4),
        "intent": intent,
        "terms": {"align": align, "preserve": round(p, 4), "quality": round(q, 4)},
        "weights": {"align": wa, "preserve": wp, "quality": wq},
        "flags": flags,
    }


def reward(render_path: str, src_path: str, instruction: str = "", intent: str = "reimagine",
           align: Optional[float] = None) -> dict:
    """Score a rendered WAV against its source WAV. Returns the scored dict augmented with
    `instruction`. Missing/unreadable files → reward 0.0 with an error flag."""
    try:
        r, sr = load_mono(render_path)
        s, _ = load_mono(src_path)
    except (OSError, ValueError) as e:
        return {"reward": 0.0, "intent": intent, "instruction": instruction,
                "terms": {"align": align, "preserve": 0.0, "quality": 0.0},
                "flags": ["unreadable"], "error": str(e)}
    out = score_arrays(r, s, sr, intent=intent, align=align)
    out["instruction"] = instruction
    return out


def rewards_jsonl_line(rid: str, instruction: str, intent: str, envelope: dict,
                       scored: dict) -> dict:
    """A line for rewards.jsonl — matches the documented MOSH_RL_REWARD=audio seam so a
    future GRPO loop reads it unchanged."""
    return {
        "id": rid,
        "instruction": instruction,
        "intent": intent,
        "envelope": envelope,
        "terms": scored.get("terms", {}),
        "flags": scored.get("flags", []),
        "reward": scored.get("reward", 0.0),
    }


def append_rewards_jsonl(path: str, line: dict) -> None:
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(line) + "\n")
