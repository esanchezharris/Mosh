from __future__ import annotations

import math
import sys
import wave
from array import array
from pathlib import Path


def _read_pcm16_mono(path: Path) -> tuple[wave._wave_params, array]:
    with wave.open(str(path), "rb") as handle:
        params = handle.getparams()
        if params.nchannels != 1 or params.sampwidth != 2 or params.comptype != "NONE":
            raise RuntimeError(f"localized repair requires mono PCM16 WAV: {path}")
        samples = array("h")
        samples.frombytes(handle.readframes(params.nframes))
    if sys.byteorder != "little":
        samples.byteswap()
    return params, samples


def _rms(samples: array, start: int, end: int) -> float:
    if end <= start:
        return 0.0
    return math.sqrt(sum(float(sample) ** 2 for sample in samples[start:end]) / (end - start))


def _clamp_pcm16(value: float) -> int:
    return max(-32768, min(32767, round(value)))


def splice_pcm16_mono(
    baseline_path: Path,
    replacement_path: Path,
    output_path: Path,
    *,
    patch_start_s: float,
    patch_end_s: float,
    crossfade_s: float,
) -> dict:
    baseline_params, baseline = _read_pcm16_mono(baseline_path)
    replacement_params, replacement = _read_pcm16_mono(replacement_path)
    if baseline_params[:4] != replacement_params[:4] or len(baseline) != len(replacement):
        raise RuntimeError("localized repair sources must have identical PCM format and duration")
    sample_rate = baseline_params.framerate
    start = round(patch_start_s * sample_rate)
    end = round(patch_end_s * sample_rate)
    fade = round(crossfade_s * sample_rate)
    if start < 0 or end > len(baseline) or start >= end or fade < 2 or end - start <= 2 * fade:
        raise RuntimeError("localized repair span or crossfade is invalid")

    baseline_rms = _rms(baseline, start, end)
    replacement_rms = _rms(replacement, start, end)
    gain = min(2.0, max(0.5, baseline_rms / replacement_rms)) if replacement_rms else 1.0
    rendered = array("h", baseline)

    for offset in range(fade):
        theta = offset / (fade - 1) * math.pi / 2
        index = start + offset
        rendered[index] = _clamp_pcm16(baseline[index] * math.cos(theta) + replacement[index] * gain * math.sin(theta))
    for index in range(start + fade, end - fade):
        rendered[index] = _clamp_pcm16(replacement[index] * gain)
    for offset in range(fade):
        theta = offset / (fade - 1) * math.pi / 2
        index = end - fade + offset
        rendered[index] = _clamp_pcm16(replacement[index] * gain * math.cos(theta) + baseline[index] * math.sin(theta))

    output_path.parent.mkdir(parents=True, exist_ok=True)
    write_samples = array("h", rendered)
    if sys.byteorder != "little":
        write_samples.byteswap()
    with wave.open(str(output_path), "wb") as handle:
        handle.setparams(baseline_params)
        handle.writeframes(write_samples.tobytes())

    outside_changed = sum(rendered[index] != baseline[index] for index in range(0, start))
    outside_changed += sum(rendered[index] != baseline[index] for index in range(end, len(baseline)))
    return {
        "baseline": str(baseline_path),
        "replacement": str(replacement_path),
        "output": str(output_path),
        "sampleRate": sample_rate,
        "patchStartS": start / sample_rate,
        "patchEndS": end / sample_rate,
        "crossfadeS": fade / sample_rate,
        "levelMatchGain": gain,
        "outsidePatchChangedSamples": outside_changed,
    }
