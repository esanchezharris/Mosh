from __future__ import annotations

import statistics
import sys
import wave
from array import array
from pathlib import Path

TTS_ALIASES = {"in": "inn"}


def _minimum_duration(word: dict) -> float:
    phones = list(word.get("phones") or [])
    if phones == ["DH", "AH0"]:
        return 0.14
    vowels = sum(phone[-1:].isdigit() for phone in phones)
    consonants = len(phones) - vowels
    return min(0.32, max(0.10, vowels * 0.055 + consonants * 0.02))


def build_lexical_targets(plan: dict, *, trailing_guard_s: float = 0.01) -> list[dict]:
    words = plan.get("words", [])
    clip_end = float(plan["clip"]["end"])
    targets = []
    for index, word in enumerate(words):
        start, original_end = float(word["start"]), float(word["end"])
        following_start = float(words[index + 1]["start"]) if index + 1 < len(words) else clip_end
        available_end = max(original_end, following_start - trailing_guard_s)
        end = min(max(original_end, start + _minimum_duration(word)), available_end)
        pitches = [int(syllable["midiPitch"]) for syllable in word.get("syllables", [])]
        if not pitches:
            raise RuntimeError(f"lexical target has no measured pitch: {word.get('ownerId')}")
        targets.append(
            {
                "text": str(word["text"]),
                "ttsText": TTS_ALIASES.get(str(word["text"]).lower(), str(word["text"])),
                "ownerId": str(word["ownerId"]),
                "start": start,
                "end": end,
                "duration": end - start,
                "originalEnd": original_end,
                "minimumDuration": _minimum_duration(word),
                "targetMidi": round(statistics.median(pitches)),
                "pitchProvenance": "measured-target",
                "phones": list(word.get("phones") or []),
            }
        )
    return targets


def _read_pcm16_mono(path: Path, expected_sample_rate: int) -> array:
    with wave.open(str(path), "rb") as handle:
        if handle.getnchannels() != 1 or handle.getsampwidth() != 2 or handle.getframerate() != expected_sample_rate:
            raise RuntimeError(f"lexical segment must be mono PCM16 at {expected_sample_rate}Hz: {path}")
        samples = array("h")
        samples.frombytes(handle.readframes(handle.getnframes()))
    if sys.byteorder != "little":
        samples.byteswap()
    return samples


def assemble_pcm16_mono(
    segments: list[dict],
    output_path: Path,
    *,
    duration_s: float,
    sample_rate: int = 24000,
    fade_s: float = 0.005,
) -> dict:
    total_frames = round(duration_s * sample_rate)
    rendered = array("h", [0] * total_frames)
    occupied = bytearray(total_frames)
    fade_frames = round(fade_s * sample_rate)
    spans = []
    for segment in segments:
        start = round(float(segment["start"]) * sample_rate)
        end = round(float(segment["end"]) * sample_rate)
        if start < 0 or start >= end or end > total_frames:
            raise RuntimeError(f"invalid lexical segment span: {segment.get('ownerId')}")
        samples = _read_pcm16_mono(Path(segment["path"]), sample_rate)
        expected = end - start
        if len(samples) < expected:
            samples.extend([0] * (expected - len(samples)))
        elif len(samples) > expected:
            del samples[expected:]
        for offset, sample in enumerate(samples):
            index = start + offset
            if occupied[index]:
                raise RuntimeError(f"overlapping lexical segment: {segment.get('ownerId')}")
            gain = 1.0
            if fade_frames:
                gain = min(1.0, (offset + 1) / fade_frames, (expected - offset) / fade_frames)
            rendered[index] = round(sample * gain)
            occupied[index] = 1
        spans.append((start, end))

    output_path.parent.mkdir(parents=True, exist_ok=True)
    write_samples = array("h", rendered)
    if sys.byteorder != "little":
        write_samples.byteswap()
    with wave.open(str(output_path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(sample_rate)
        handle.writeframes(write_samples.tobytes())
    outside = sum(sample != 0 and not occupied[index] for index, sample in enumerate(rendered))
    return {
        "sampleRate": sample_rate,
        "durationS": total_frames / sample_rate,
        "placedWords": len(segments),
        "wordSpans": [[start / sample_rate, end / sample_rate] for start, end in spans],
        "nonSilentOutsideWordSpans": outside,
    }
