#!/usr/bin/env python3
"""Compute waveform peaks for the Song A stems → ui/src/mock/fixtures/songA.peaks.json.

The dev/e2e mock's `?mockSeed=portfolio` session draws REAL waveforms from this fixture
(bridge.mock.ts `get_clip_peaks` slices a stem's peaks by clip offset/length). The stems
themselves live outside the repo (~/Library/Mosh/references/songs/greg/mosh/audio); only the
tiny min/max envelope is committed.

Usage: python3 scripts/portfolio/song_a_peaks.py [--per-sec 16] [--bpm 145] [--out PATH]
Prints a per-bar RMS map for each stem (in dB) so clip cuts and sections come from the audio.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys

import numpy as np
import soundfile as sf

STEMS = {
    "beat": "beat.wav",
    "lead": "greg lead.wav",
    "double": "greg double.wav",
    "background": "greg background.wav",
    "rough": "greg.wav",
}
DEFAULT_SRC = os.path.expanduser("~/Library/Mosh/references/songs/greg/mosh/audio")
DEFAULT_OUT = os.path.join(os.path.dirname(__file__), "..", "..", "ui", "src", "mock", "fixtures", "songA.peaks.json")


def envelope(mono: np.ndarray, sr: int, per_sec: int) -> list[list[float]]:
    hop = sr / per_sec
    n = int(math.ceil(len(mono) / hop))
    out: list[list[float]] = []
    for i in range(n):
        a, b = int(i * hop), int(min(len(mono), (i + 1) * hop))
        seg = mono[a:b]
        if seg.size == 0:
            out.append([0.0, 0.0])
            continue
        out.append([round(float(seg.min()), 3), round(float(seg.max()), 3)])
    return out


def bar_rms_db(mono: np.ndarray, sr: int, bpm: float) -> list[float]:
    bar = sr * 60.0 / bpm * 4
    n = int(math.ceil(len(mono) / bar))
    vals = []
    for i in range(n):
        seg = mono[int(i * bar):int(min(len(mono), (i + 1) * bar))]
        rms = float(np.sqrt(np.mean(seg * seg))) if seg.size else 0.0
        vals.append(round(20 * math.log10(max(rms, 1e-9)), 1))
    return vals


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default=DEFAULT_SRC)
    ap.add_argument("--out", default=os.path.normpath(DEFAULT_OUT))
    ap.add_argument("--per-sec", type=int, default=16)
    ap.add_argument("--bpm", type=float, default=145.0)
    args = ap.parse_args()

    fixture = {"perSec": args.per_sec, "bpm": args.bpm, "stems": {}, "durationSec": {}}
    for key, name in STEMS.items():
        path = os.path.join(args.src, name)
        data, sr = sf.read(path, dtype="float32", always_2d=True)
        mono = data.mean(axis=1)
        peak = float(np.max(np.abs(mono))) or 1.0
        fixture["stems"][key] = envelope(mono / peak, sr, args.per_sec)
        fixture["durationSec"][key] = round(len(mono) / sr, 3)
        bars = bar_rms_db(mono, sr, args.bpm)
        print(f"{key:11s} {len(mono)/sr:6.2f}s  peak {peak:.3f}  bars(dB): " + " ".join(f"{i+1}:{v:g}" for i, v in enumerate(bars)))

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w") as fh:
        json.dump(fixture, fh, separators=(",", ":"))
    print(f"wrote {args.out} ({os.path.getsize(args.out)} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
