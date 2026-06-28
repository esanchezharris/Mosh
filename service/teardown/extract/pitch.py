"""Monophonic pitch → MIDI (bass/808 lines are reliable because they're monophonic).
librosa.pyin only — no install. Groups the f0 contour into note segments.
"""
from __future__ import annotations

import numpy as np

SR = 44100


def mono_to_midi(y: np.ndarray, sr: int = SR, fmin: float = 32.7, fmax: float = 1046.5,
                 min_note_s: float = 0.06) -> list[dict]:
    """Returns notes [{pitch, start, end, velocity}] (pitch = MIDI int, times in seconds)."""
    import librosa

    y = np.asarray(y, dtype=np.float32)
    if y.size < int(0.05 * sr):
        return []
    f0, voiced, _ = librosa.pyin(y, sr=sr, fmin=fmin, fmax=fmax)
    times = librosa.times_like(f0, sr=sr)

    notes: list[dict] = []
    cur_pitch = None
    cur_start = 0.0
    for i, f in enumerate(f0):
        midi = int(round(float(librosa.hz_to_midi(f)))) if (voiced[i] and f == f and f > 0) else None
        if midi != cur_pitch:
            if cur_pitch is not None:
                notes.append({"pitch": cur_pitch, "start": round(cur_start, 3),
                              "end": round(float(times[i]), 3), "velocity": 90})
            cur_pitch = midi
            cur_start = float(times[i])
    if cur_pitch is not None:
        notes.append({"pitch": cur_pitch, "start": round(cur_start, 3),
                      "end": round(float(times[-1]), 3), "velocity": 90})
    return [n for n in notes if (n["end"] - n["start"]) >= min_note_s]
