"""Deterministic melody correction: pitch a natural render onto the take's score.

ACE covers sing the right words in a natural voice but re-melodize; the
render plan carries the take's per-syllable spans + measured MIDI. This
module shifts each voiced syllable of a candidate onto its target pitch
(rubberband, formant-preserving, the lexical-pivot idiom: measured median
F0 -> semitone delta, clamped ±7st) and splices the shifted segments back
with short fades. Melody-exact by construction; everything outside voiced
syllable spans passes through untouched.
"""

from __future__ import annotations

import math
import sys
import tempfile
from pathlib import Path
from statistics import median

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from asserted_proof_runtime import RUBBERBAND, convert_audio, dump_json, run  # noqa: E402
from asserted_proof_splice import _clamp_pcm16, _read_pcm16_mono  # noqa: E402

MIN_SHIFT_ST = 0.05
MIN_VOICED_FRAMES = 2


def syllable_targets_from_plan(plan: dict) -> list[dict]:
    clip_start = float(plan["clip"]["start"])
    targets = []
    for word in plan["words"]:
        for index, syllable in enumerate(word.get("syllables", [])):
            start = float(syllable["start"]) - clip_start
            end = float(syllable["end"]) - clip_start
            if end <= start:
                continue
            targets.append(
                {
                    "ownerId": f"{word.get('ownerId')}-syl{index}",
                    "word": str(word.get("text")),
                    "startS": round(start, 4),
                    "endS": round(end, 4),
                    "targetMidi": float(syllable["midiPitch"]),
                }
            )
    return targets


def segment_shifts(targets: list[dict], f0_points: list[dict], *, clamp_st: float = 7.0) -> list[dict]:
    shifted = []
    for target in targets:
        voiced = [float(point["hz"]) for point in f0_points if target["startS"] <= float(point["t"]) < target["endS"] and float(point["hz"]) > 0.0]
        entry = dict(target)
        if len(voiced) < MIN_VOICED_FRAMES:
            entry.update({"measuredMidi": None, "requestedShiftSt": None, "shiftSt": None})
        else:
            measured = 69.0 + 12.0 * math.log2(median(voiced) / 440.0)
            requested = target["targetMidi"] - measured
            entry.update(
                {
                    "measuredMidi": round(measured, 4),
                    "requestedShiftSt": round(requested, 4),
                    "shiftSt": round(max(-clamp_st, min(clamp_st, requested)), 4),
                }
            )
        shifted.append(entry)
    return shifted


def paste_segment(base: list[int], segment: list[int], *, start_index: int, fade_frames: int) -> list[int]:
    end_index = start_index + len(segment)
    if start_index < 0 or end_index > len(base):
        raise RuntimeError(f"segment [{start_index}:{end_index}] does not fit the base of {len(base)} frames")
    out = list(base)
    for offset, value in enumerate(segment):
        index = start_index + offset
        gain = 1.0
        if fade_frames:
            gain = min(1.0, (offset + 1) / fade_frames, (len(segment) - offset) / fade_frames)
        out[index] = _clamp_pcm16(value * gain + base[index] * (1.0 - gain))
    return out


def melody_correct_wav(source_wav: Path, plan: dict, f0_points: list[dict], output_wav: Path, *, clamp_st: float = 7.0, fade_s: float = 0.005) -> dict:
    params, base_array = _read_pcm16_mono(source_wav)
    sample_rate = params.framerate
    base = list(base_array)
    targets = segment_shifts(syllable_targets_from_plan(plan), f0_points, clamp_st=clamp_st)
    fade_frames = max(2, round(fade_s * sample_rate))
    corrected = 0
    skipped_unvoiced = 0
    skipped_small = 0
    with tempfile.TemporaryDirectory() as temporary:
        workdir = Path(temporary)
        for index, target in enumerate(targets):
            if target["shiftSt"] is None:
                skipped_unvoiced += 1
                continue
            if abs(target["shiftSt"]) < MIN_SHIFT_ST:
                skipped_small += 1
                continue
            duration = target["endS"] - target["startS"]
            segment_raw = workdir / f"seg-{index}.wav"
            segment_shifted = workdir / f"seg-{index}-shifted.wav"
            segment_fitted = workdir / f"seg-{index}-fitted.wav"
            convert_audio(source_wav, segment_raw, start=target["startS"], duration=duration, sample_rate=sample_rate)
            run([str(RUBBERBAND), "-q", "-3", "-F", "-p", f"{target['shiftSt']:.6f}", str(segment_raw), str(segment_shifted)])
            run(
                [
                    "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
                    "-i", str(segment_shifted),
                    "-af", f"apad,atrim=0:{duration:.6f}",
                    "-ac", "1", "-ar", str(sample_rate), "-c:a", "pcm_s16le",
                    str(segment_fitted),
                ]
            )
            _, segment_samples = _read_pcm16_mono(segment_fitted)
            start_index = round(target["startS"] * sample_rate)
            segment_list = list(segment_samples)[: len(base) - start_index]
            base = paste_segment(base, segment_list, start_index=start_index, fade_frames=fade_frames)
            corrected += 1
    from array import array
    import wave

    output_wav.parent.mkdir(parents=True, exist_ok=True)
    out_samples = array("h", base)
    if sys.byteorder != "little":
        out_samples.byteswap()
    with wave.open(str(output_wav), "wb") as handle:
        handle.setparams(params)
        handle.writeframes(out_samples.tobytes())
    metadata = {
        "version": 1,
        "source": str(source_wav),
        "output": str(output_wav),
        "clampSt": clamp_st,
        "fadeS": fade_s,
        "correctedSegments": corrected,
        "skippedUnvoiced": skipped_unvoiced,
        "skippedSmallShift": skipped_small,
        "segments": targets,
    }
    return metadata
