from __future__ import annotations

import struct
import sys
import wave
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from asserted_proof_cover_post import (  # noqa: E402
    apply_keep_windows,
    enforce_silence_wav,
    keep_windows_from_plan,
)


def _plan(spans: list[tuple[float, float]], clip_start: float = 0.35, clip_end: float = 7.90) -> dict:
    words = [{"text": f"w{index}", "start": clip_start + start, "end": clip_start + end} for index, (start, end) in enumerate(spans)]
    return {"clip": {"start": clip_start, "end": clip_end}, "words": words}


def test_keep_windows_are_clip_relative_padded_and_merged() -> None:
    plan = _plan([(1.0, 1.5), (1.55, 2.0), (4.0, 4.3)])
    windows = keep_windows_from_plan(plan, pre_pad_s=0.06, post_pad_s=0.12)
    # First two words: [0.94, 1.62] and [1.49, 2.12] overlap -> merged.
    assert windows == [(0.94, 2.12), (3.94, 4.42)]


def test_keep_windows_clamp_to_clip_bounds() -> None:
    plan = _plan([(0.02, 0.2), (7.3, 7.53)])
    windows = keep_windows_from_plan(plan)
    assert windows[0][0] == 0.0
    assert windows[-1][1] == pytest.approx(7.55)


def test_apply_keep_windows_zeroes_outside_and_fades_edges() -> None:
    sample_rate = 1000
    samples = [10000] * 1000  # 1s of constant signal
    kept = apply_keep_windows(samples, sample_rate, [(0.3, 0.7)], fade_s=0.01)
    assert kept[0] == 0 and kept[299] == 0  # before window
    assert kept[750] == 0 and kept[-1] == 0  # after window
    assert kept[500] == 10000  # middle untouched
    assert 0 < kept[302] < 10000  # fade-in ramp
    assert 0 < kept[698] < 10000  # fade-out ramp


def test_apply_keep_windows_full_window_is_a_noop() -> None:
    samples = [123, -456, 789, -1, 0, 32000]
    kept = apply_keep_windows(samples, 1000, [(0.0, 1.0)], fade_s=0.0)
    assert kept == samples


def test_enforce_silence_wav_round_trip(tmp_path: Path) -> None:
    sample_rate = 24000
    source = tmp_path / "source.wav"
    frames = [5000] * sample_rate  # 1s constant
    with wave.open(str(source), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(sample_rate)
        handle.writeframes(struct.pack(f"<{len(frames)}h", *frames))
    output = tmp_path / "enforced.wav"
    stats = enforce_silence_wav(source, output, [(0.25, 0.5)], fade_s=0.005)
    with wave.open(str(output), "rb") as handle:
        assert handle.getframerate() == sample_rate
        data = struct.unpack(f"<{handle.getnframes()}h", handle.readframes(handle.getnframes()))
    assert all(value == 0 for value in data[: int(0.24 * sample_rate)])
    assert all(value == 0 for value in data[int(0.51 * sample_rate) :])
    assert data[int(0.375 * sample_rate)] == 5000
    assert stats["keptRatio"] == pytest.approx(0.25, abs=0.02)
    assert stats["windows"] == [[0.25, 0.5]]
