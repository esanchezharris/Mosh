"""Stereo A/B mixer — the by-ear judging tool for "does the verse sit on the mumble?"

Reading a fit table can't tell you if a word lands on your take; hearing them together
can. `stereo_ab` puts the raw mumble in the LEFT ear and the words-on-your-melody guide in
the RIGHT, on one common timeline, so alignment (or drift) is immediately audible.

Pure stdlib (wave) + audio_io.write_wav. Deterministic; linear resampling so a guide at
44.1k and a take at 48k line up in time.
"""
from __future__ import annotations

import os
import struct
import sys
import wave
from typing import List, Tuple

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # service/
from audio_io import write_wav  # noqa: E402


def _read_mono(path: str) -> Tuple[List[float], int]:
    """Read a WAV as mono floats in [-1, 1] (downmixing any extra channels)."""
    with wave.open(path, "rb") as w:
        ch, sw, sr, n = w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()
        raw = w.readframes(n)
    if sw != 2:                                  # only 16-bit PCM is produced in this pipeline
        raise ValueError(f"{path}: expected 16-bit PCM, got sampwidth={sw}")
    ints = struct.unpack("<%dh" % (len(raw) // 2), raw) if raw else ()
    if ch <= 1:
        return [s / 32768.0 for s in ints], sr
    frames = len(ints) // ch
    return [sum(ints[i * ch:i * ch + ch]) / (ch * 32768.0) for i in range(frames)], sr


def _resample_linear(samples: List[float], sr_in: int, sr_out: int) -> List[float]:
    """Linear-interpolation resample. Identity when the rates already match."""
    if sr_in == sr_out or not samples:
        return list(samples)
    out_n = max(1, round(len(samples) * sr_out / float(sr_in)))
    ratio = sr_in / float(sr_out)
    out: List[float] = []
    last = len(samples) - 1
    for j in range(out_n):
        pos = j * ratio
        i = int(pos)
        if i >= last:
            out.append(samples[last])
        else:
            frac = pos - i
            out.append(samples[i] * (1.0 - frac) + samples[i + 1] * frac)
    return out


def stereo_ab(left_wav: str, right_wav: str, out_wav: str, sr: int = 44100,
              left_gain: float = 1.0, right_gain: float = 1.0) -> dict:
    """Write a stereo WAV with `left_wav` in the left channel and `right_wav` in the right,
    both resampled to `sr`. The output runs to the longer input (shorter is zero-padded), so
    two takes that start at t=0 stay time-aligned. Returns a small stats dict."""
    left, sl = _read_mono(left_wav)
    right, sr_r = _read_mono(right_wav)
    left = _resample_linear(left, sl, sr)
    right = _resample_linear(right, sr_r, sr)
    n = max(len(left), len(right))
    inter: List[float] = [0.0] * (n * 2)
    for i in range(n):
        inter[2 * i] = (left[i] * left_gain) if i < len(left) else 0.0
        inter[2 * i + 1] = (right[i] * right_gain) if i < len(right) else 0.0
    write_wav(out_wav, inter, 2, sr)
    return {"frames": n, "sample_rate": sr, "duration_s": round(n / float(sr), 3)}
