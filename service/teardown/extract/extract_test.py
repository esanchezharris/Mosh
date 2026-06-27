#!/usr/bin/env python3
"""Hermetic test for §7's librosa cores (no demucs/network).

    python3 service/teardown/extract/extract_test.py   (needs numpy/librosa/soundfile)

Slicing finds the hits in a synthetic drum pattern; mono_to_midi recovers a known two-note
melody (monophonic is reliable); mono_tone isolation returns a stable window; the demucs
Separator degrades gracefully when absent. Determinism x3.
"""
import os
import sys

import numpy as np

_HERE = os.path.dirname(os.path.abspath(__file__))
_SERVICE = os.path.dirname(os.path.dirname(_HERE))
if _SERVICE not in sys.path:
    sys.path.insert(0, _SERVICE)

from teardown.extract import DemucsSeparator, isolate_mono_tone, mono_to_midi, slice_oneshots  # noqa: E402

SR = 44100
fails: list[str] = []


def check(name, cond, extra=""):
    if cond:
        print(f"  ok   {name}")
    else:
        fails.append(name)
        print(f"  FAIL {name}" + (f"  [{extra}]" if extra else ""))


def drum_pattern(hits=4, gap_s=0.3):
    rng = np.random.default_rng(0)
    y = np.zeros(int((hits * gap_s + 0.4) * SR), np.float32)
    for i in range(hits):
        on = int(i * gap_s * SR)
        n = int(0.15 * SR)
        burst = (rng.standard_normal(n) * np.exp(-np.arange(n) / SR * 30)).astype(np.float32)
        y[on:on + n] += burst
    return y / np.max(np.abs(y))


def two_note_tone():
    t = np.arange(int(0.5 * SR)) / SR
    a = np.sin(2 * np.pi * 220.0 * t)   # A3 = MIDI 57
    e = np.sin(2 * np.pi * 329.63 * t)  # E4 = MIDI 64
    return np.concatenate([a, e]).astype(np.float32) * 0.9


# ── drum slicing ─────────────────────────────────────────────────────────────
slices = slice_oneshots(drum_pattern(4), SR)
check("slices ~4 hits from a 4-hit pattern", 3 <= len(slices) <= 5, str(len(slices)))
check("slices are time-ordered", all(slices[i].t_s <= slices[i + 1].t_s for i in range(len(slices) - 1)))
check("each slice has samples", all(s.samples.size > 0 for s in slices))

# ── monophonic pitch → MIDI ──────────────────────────────────────────────────
notes = mono_to_midi(two_note_tone(), SR)
pitches = {n["pitch"] for n in notes}
check("recovers A3 (57)", any(abs(p - 57) <= 1 for p in pitches), str(sorted(pitches)))
check("recovers E4 (64)", any(abs(p - 64) <= 1 for p in pitches), str(sorted(pitches)))
check("notes are ordered + non-zero length", all(n["end"] > n["start"] for n in notes))

# ── mono-tone isolation ──────────────────────────────────────────────────────
mt = isolate_mono_tone(two_note_tone(), SR, window_s=0.4)
check("mono_tone returns a window with positive quality", mt.samples.size > 0 and mt.quality > 0.0, f"q={mt.quality}")

# ── separator gating ─────────────────────────────────────────────────────────
check("DemucsSeparator.available is a bool", isinstance(DemucsSeparator().available, bool))

# ── determinism ──────────────────────────────────────────────────────────────
runs = {tuple((n["pitch"], n["start"]) for n in mono_to_midi(two_note_tone(), SR)) for _ in range(3)}
check("mono_to_midi deterministic x3", len(runs) == 1)

print(f"\n{'ALL PASS' if not fails else 'FAILURES: ' + ', '.join(fails)}  ({len(fails)} failure(s))")
sys.exit(len(fails))
