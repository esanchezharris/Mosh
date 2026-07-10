from __future__ import annotations

import math
import struct
import wave
from pathlib import Path
from statistics import median


def read_pcm(path: Path) -> tuple[list[float], int]:
    with wave.open(str(path), "rb") as handle:
        channels = handle.getnchannels()
        sample_width = handle.getsampwidth()
        sample_rate = handle.getframerate()
        raw = handle.readframes(handle.getnframes())
    if sample_width != 2:
        raise RuntimeError(f"metrics require PCM16 audio: {path}")
    values = struct.unpack(f"<{len(raw) // 2}h", raw)
    if channels == 1:
        return [value / 32768.0 for value in values], sample_rate
    frames = len(values) // channels
    return [sum(values[index * channels : (index + 1) * channels]) / channels / 32768.0 for index in range(frames)], sample_rate


def rms_envelope(samples: list[float], sample_rate: int, hop_s: float = 0.01) -> list[float]:
    hop = max(1, round(sample_rate * hop_s))
    return [math.sqrt(sum(value * value for value in samples[index : index + hop]) / max(1, len(samples[index : index + hop]))) for index in range(0, len(samples), hop)]


def correlation(left: list[float], right: list[float]) -> float:
    size = min(len(left), len(right))
    if size < 2:
        return 0.0
    x, y = left[:size], right[:size]
    mean_x, mean_y = sum(x) / size, sum(y) / size
    numerator = sum((a - mean_x) * (b - mean_y) for a, b in zip(x, y))
    denominator = math.sqrt(sum((a - mean_x) ** 2 for a in x) * sum((b - mean_y) ** 2 for b in y))
    return numerator / denominator if denominator else 0.0


def _percentile(values: list[float], fraction: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, round((len(ordered) - 1) * fraction))]


def _attack_errors(plan: dict, envelope: list[float], hop_s: float) -> list[float]:
    deltas = [max(0.0, envelope[index] - envelope[index - 1]) for index in range(1, len(envelope))]
    offset = float(plan["clip"]["start"])
    errors: list[float] = []
    for word in plan["words"]:
        for syllable in word["syllables"]:
            target = float(syllable["start"]) - offset
            low = max(0, int((target - 0.15) / hop_s))
            high = min(len(deltas), int((target + 0.15) / hop_s) + 1)
            if high <= low:
                continue
            attack = max(range(low, high), key=deltas.__getitem__) * hop_s
            errors.append(abs(attack - target))
    return errors


def _pitch_metrics(plan: dict, rendered_f0: list[dict]) -> tuple[float, float]:
    offset = float(plan["clip"]["start"])
    errors: list[float] = []
    octave_run = 0.0
    current_run = 0.0
    for word in plan["words"]:
        for syllable in word["syllables"]:
            start = float(syllable["start"]) - offset
            end = float(syllable["end"]) - offset
            voiced = [float(point["hz"]) for point in rendered_f0 if start <= float(point["t"]) < end and float(point["hz"]) > 0]
            if not voiced:
                current_run = 0.0
                continue
            rendered_midi = 69.0 + 12.0 * math.log2(median(voiced) / 440.0)
            error = abs(rendered_midi - float(syllable["midiPitch"]))
            errors.append(error)
            current_run = current_run + (end - start) if error >= 11.5 else 0.0
            octave_run = max(octave_run, current_run)
    return (median(errors) if errors else 99.0), octave_run


def compare_audio(plan: dict, raw_path: Path, rendered_path: Path, rendered_f0: list[dict]) -> dict:
    raw, raw_rate = read_pcm(raw_path)
    rendered, rendered_rate = read_pcm(rendered_path)
    if raw_rate != rendered_rate:
        raise RuntimeError(f"sample-rate mismatch: {raw_rate} != {rendered_rate}")
    raw_env, rendered_env = rms_envelope(raw, raw_rate), rms_envelope(rendered, rendered_rate)
    size = min(len(raw_env), len(rendered_env))
    raw_peak = max(raw_env[:size], default=1.0)
    rendered_peak = max(rendered_env[:size], default=1.0)
    bleed_frames = [raw_env[index] < raw_peak * 0.04 and rendered_env[index] >= rendered_peak * 0.08 for index in range(size)]
    longest = run = 0
    for frame in bleed_frames:
        run = run + 1 if frame else 0
        longest = max(longest, run)
    attack_errors = _attack_errors(plan, rendered_env, 0.01)
    pitch_error, octave_run = _pitch_metrics(plan, rendered_f0)
    return {
        "envelopeCorrelation": round(correlation(raw_env, rendered_env), 4),
        "rmsRatio": round((sum(rendered_env[:size]) / max(1, size)) / max(1e-8, sum(raw_env[:size]) / max(1, size)), 4),
        "medianAttackErrorMs": round(median(attack_errors) * 1000, 2) if attack_errors else None,
        "p95AttackErrorMs": round(_percentile(attack_errors, 0.95) * 1000, 2) if attack_errors else None,
        "silenceBleedMs": round(longest * 10.0, 2),
        "medianVoicedPitchErrorSemitones": round(pitch_error, 3),
        "longestOctaveErrorMs": round(octave_run * 1000, 2),
    }
