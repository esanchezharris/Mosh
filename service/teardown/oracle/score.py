"""Scoring: loudness-normalize, embed, compare.

`loudness_normalize` rescales to a fixed level BEFORE embedding so a consumer can't win
by getting louder (the cheapest reward hack). v0 uses RMS-to-target (a robust proxy); a
true ITU-LUFS pass lands when pyloudnorm is in the venv. `EmbeddingScorer` reuses §1's
engineered embedder as the v0 distance — §11's learned head swaps in here later via the
versioned interface, and every consumer (§8/§9/§12) upgrades for free.
"""
from __future__ import annotations

from typing import Union

import numpy as np

from ..drummatch.embed import SR, EngineeredEmbedder

AudioArg = Union["np.ndarray", tuple]
TARGET_RMS_DBFS = -20.0


def loudness_normalize(y: np.ndarray, sr: int = SR, target_rms_dbfs: float = TARGET_RMS_DBFS) -> np.ndarray:
    """Scale to a fixed RMS level; guard against clipping. Silent input passes through."""
    y = np.asarray(y, dtype=np.float32)
    if y.size == 0:
        return y
    rms = float(np.sqrt(np.mean(y.astype(np.float64) ** 2)))
    if rms < 1e-9:
        return y
    gain = (10.0 ** (target_rms_dbfs / 20.0)) / rms
    out = y * gain
    peak = float(np.max(np.abs(out)))
    # Guard to a ceiling BELOW the floor's broken-clip threshold (peak > 0.999), with headroom.
    # RMS-normalizing transient-heavy audio (drums, crest ≳ 10) drives the peak past full-scale;
    # the old ceiling of 1.0 left peak==1.0 → the floor flagged it "clipped/broken" → clean=0,
    # zeroing the reward for every legitimate non-silent render. Real-music mixes (crest < ~9.9)
    # land below this ceiling, so it's a no-op for them (validated pull/keystone unchanged).
    PEAK_CEILING = 0.99
    if peak > PEAK_CEILING:
        out = out * (PEAK_CEILING / peak)
    return out.astype(np.float32)


def _unpack(a: AudioArg, sr: int) -> tuple[np.ndarray, int]:
    if isinstance(a, tuple):
        return np.asarray(a[0], dtype=np.float32), int(a[1])
    return np.asarray(a, dtype=np.float32), sr


class EmbeddingScorer:
    """Distance = 1 - cosine of loudness-normalized embeddings. Lower = more similar."""

    def __init__(self, embedder=None, target_rms_dbfs: float = TARGET_RMS_DBFS) -> None:
        self.embedder = embedder or EngineeredEmbedder()
        self.target_rms_dbfs = target_rms_dbfs
        self.version = f"embcos-{self.embedder.version}-rms{int(target_rms_dbfs)}"

    def _vec(self, y: np.ndarray, sr: int) -> np.ndarray:
        yn = loudness_normalize(y, sr, self.target_rms_dbfs)
        v = np.asarray(self.embedder.embed(yn, sr), dtype=np.float64)
        n = float(np.linalg.norm(v))
        return v / (n if n > 1e-12 else 1.0)

    def score(self, a: AudioArg, b: AudioArg, sr: int = SR) -> float:
        ya, sra = _unpack(a, sr)
        yb, srb = _unpack(b, sr)
        return float(1.0 - np.dot(self._vec(ya, sra), self._vec(yb, srb)))
