"""Slice a drums stem into per-hit one-shots (onset detection), so each hit can round-trip
through §1 to a sample the owner owns. librosa-only (no heavy install); deterministic.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import numpy as np

SR = 44100


@dataclass
class Slice:
    t_s: float
    samples: np.ndarray
    role_guess: str = "other"
    path: Optional[str] = None


def slice_oneshots(y: np.ndarray, sr: int = SR, max_hits: int = 64,
                   min_len_s: float = 0.02, tail_s: float = 0.6,
                   out_dir: Optional[Path] = None) -> list[Slice]:
    """Onset-detect → cut [onset, next_onset | onset+tail] → peak-normalize → (optionally
    write a wav + role-guess each). Returns the slices in time order."""
    import librosa

    y = np.asarray(y, dtype=np.float32)
    if y.size == 0:
        return []
    onsets = librosa.onset.onset_detect(y=y, sr=sr, units="samples", backtrack=True)
    out: list[Slice] = []
    for i, on in enumerate(onsets):
        if len(out) >= max_hits:
            break
        nxt = onsets[i + 1] if i + 1 < len(onsets) else min(len(y), on + int(tail_s * sr))
        seg = y[on:nxt]
        if seg.size < int(min_len_s * sr):
            continue
        peak = float(np.max(np.abs(seg)))
        if peak < 1e-4:
            continue
        seg = (seg / peak).astype(np.float32)
        sl = Slice(t_s=round(on / sr, 4), samples=seg)
        if out_dir is not None:
            import soundfile as sf
            from ..drummatch.roles import classify_role  # role guess reuses §1
            d = Path(out_dir)
            d.mkdir(parents=True, exist_ok=True)
            p = d / f"hit_{len(out):03d}.wav"
            sf.write(str(p), seg, sr)
            sl.path = str(p)
            sl.role_guess = classify_role(seg, sr)
        out.append(sl)
    return out
