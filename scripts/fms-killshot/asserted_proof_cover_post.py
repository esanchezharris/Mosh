"""Silence enforcement for ACE cover candidates.

The raw take is the structural truth: the measured word spans say exactly
where sound belongs. This post-step zeroes the candidate outside padded,
merged keep-windows (with short linear fades) so the auditioned guide
matches the take's phrasing structure. The pre-enforcement trim is kept on
disk and its silence bleed stays the recorded model-quality signal.
"""

from __future__ import annotations

import struct
import wave
from pathlib import Path


def keep_windows_from_plan(plan: dict, *, pre_pad_s: float = 0.06, post_pad_s: float = 0.12) -> list[tuple[float, float]]:
    clip_start = float(plan["clip"]["start"])
    duration = float(plan["clip"]["end"]) - clip_start
    padded = sorted(
        (
            max(0.0, float(word["start"]) - clip_start - pre_pad_s),
            min(duration, float(word["end"]) - clip_start + post_pad_s),
        )
        for word in plan["words"]
    )
    merged: list[tuple[float, float]] = []
    for start, end in padded:
        if merged and start <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
        else:
            merged.append((start, end))
    return [(round(start, 4), round(end, 4)) for start, end in merged]


def apply_keep_windows(samples: list[int], sample_rate: int, windows: list[tuple[float, float]], *, fade_s: float = 0.01) -> list[int]:
    gains = [0.0] * len(samples)
    fade_frames = max(0, round(fade_s * sample_rate))
    for start_s, end_s in windows:
        start = max(0, round(start_s * sample_rate))
        end = min(len(samples), round(end_s * sample_rate))
        for index in range(start, end):
            gain = 1.0
            if fade_frames:
                gain = min(gain, (index - start + 1) / fade_frames, (end - index) / fade_frames)
            gains[index] = max(gains[index], min(1.0, gain))
    return [round(sample * gain) for sample, gain in zip(samples, gains)]


def enforce_silence_wav(source: Path, output: Path, windows: list[tuple[float, float]], *, fade_s: float = 0.01) -> dict:
    with wave.open(str(source), "rb") as handle:
        if handle.getnchannels() != 1 or handle.getsampwidth() != 2:
            raise RuntimeError(f"silence enforcement requires mono PCM16: {source}")
        sample_rate = handle.getframerate()
        samples = list(struct.unpack(f"<{handle.getnframes()}h", handle.readframes(handle.getnframes())))
    kept = apply_keep_windows(samples, sample_rate, windows, fade_s=fade_s)
    output.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(output), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(sample_rate)
        handle.writeframes(struct.pack(f"<{len(kept)}h", *kept))
    kept_frames = sum(1 for value in kept if value != 0)
    window_frames = sum(round((end - start) * sample_rate) for start, end in windows)
    return {
        "windows": [[start, end] for start, end in windows],
        "fadeS": fade_s,
        "sampleRate": sample_rate,
        "keptRatio": round(min(window_frames, len(samples)) / max(1, len(samples)), 4),
        "nonZeroFrames": kept_frames,
    }
