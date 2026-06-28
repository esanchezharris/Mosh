"""Isolate the cleanest monophonic tone window for §8 (the rate-limiter on synth-match
quality). Picks the most pitch-stable voiced window after the main onset. librosa-only.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

SR = 44100


@dataclass
class MonoTone:
    samples: np.ndarray
    sr: int
    t_s: float
    quality: float   # 0–1: pitch stability × voiced fraction (how mono/clean)


def isolate_mono_tone(y: np.ndarray, sr: int = SR, window_s: float = 1.0) -> MonoTone:
    import librosa

    y = np.asarray(y, dtype=np.float32)
    n = int(window_s * sr)
    if y.size <= n:
        win, t0 = y, 0.0
    else:
        # scan windows, score by pitch stability (low f0 variance) × voiced fraction
        best_i, best_q = 0, -1.0
        hop = max(1, n // 2)
        for start in range(0, y.size - n, hop):
            seg = y[start:start + n]
            f0, voiced, _ = librosa.pyin(seg, sr=sr, fmin=32.7, fmax=1046.5)
            vf = float(np.mean(voiced)) if voiced.size else 0.0
            good = f0[np.isfinite(f0) & (f0 > 0)]
            stab = 1.0 / (1.0 + float(np.std(librosa.hz_to_midi(good)))) if good.size > 1 else 0.0
            q = vf * stab
            if q > best_q:
                best_q, best_i = q, start
        win, t0 = y[best_i:best_i + n], best_i / sr
    # quality of the chosen window
    f0, voiced, _ = librosa.pyin(win, sr=sr, fmin=32.7, fmax=1046.5)
    vf = float(np.mean(voiced)) if voiced.size else 0.0
    good = f0[np.isfinite(f0) & (f0 > 0)]
    stab = 1.0 / (1.0 + float(np.std(librosa.hz_to_midi(good)))) if good.size > 1 else 0.0
    return MonoTone(samples=win.astype(np.float32), sr=sr, t_s=round(t0, 3), quality=round(vf * stab, 3))
