#!/usr/bin/env python3
"""Goldens for the consonant-evidence instrument (pure cores + synthetic audio).

Run:  python3 scripts/fms-killshot/bench_consonants_test.py   (exit 0 = all pass)
"""
import hashlib
import json
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import bench_consonants as bc  # noqa: E402

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


# ── note_phones: which notes command sibilant-class phones ──────────────────────────────
CLIP = {"duration": "0.20 0.50 0.50 0.40", "text": "<SP> see you smashing",
        "phoneme": "<SP> en_S-IY1 en_Y-UW1 en_S-M-AE1-SH", "note_pitch": "0 60 62 64",
        "note_type": "1 2 2 2", "time": [0, 1600], "index": "t", "language": "English"}
np_ = bc.note_phones(CLIP)
check("note_phones finds S on 'see', S+SH on 'smashing', nothing on 'you' or the rest",
      np_ == [("S", 1), ("S", 3), ("SH", 3)], str(np_))

# ── band_ratio_frames: known spectra ────────────────────────────────────────────────────
freqs = [500.0, 3000.0, 6000.0, 9000.0]
hiss = [[0.0, 0.0, 1.0, 1.0]]           # all energy in the S band (4-10 kHz)
voice = [[1.0, 0.5, 0.0, 0.0]]          # all energy low
r_h = bc.band_ratio_frames(hiss, freqs, bc.BANDS["S"])
r_v = bc.band_ratio_frames(voice, freqs, bc.BANDS["S"])
check("a hiss frame reads ~1.0 in the S band", abs(r_h[0] - 1.0) < 1e-9, str(r_h))
check("a voiced frame reads ~0.0 in the S band", r_v[0] < 1e-9, str(r_v))
check("silence reads 0.0 (no divide-by-zero)",
      bc.band_ratio_frames([[0.0] * 4], freqs, bc.BANDS["S"]) == [0.0])

# ── grade: the take is its own floor ────────────────────────────────────────────────────
check("take strong + render strong = present", bc.grade(0.8, 0.6, 0.25) == "present")
check("take strong + render weak = MISSING", bc.grade(0.8, 0.2, 0.25) == "missing")
check("take below its floor = unsupported (we never demand what the truth lacks)",
      bc.grade(0.1, 0.0, 0.25) == "unsupported")
check("render clears at RENDER_FRAC of the take", bc.grade(0.8, 0.4, 0.25) == "present")

# ── summarize: strong tier only, unsupported excluded ───────────────────────────────────
rows = [{"word": "see", "phone": "S", "verdict": "missing"},
        {"word": "she", "phone": "SH", "verdict": "present"},
        {"word": "fun", "phone": "F", "verdict": "missing"},        # weak tier: reported only
        {"word": "sap", "phone": "S", "verdict": "unsupported"}]
s = bc.summarize(rows)
check("summary counts strong-tier graded events only", s["graded"] == 2, str(s))
check("summary counts the missing S, not the weak-tier F", s["missing"] == 1
      and s["missing_words"] == ["see(S)"], str(s))

# ── end-to-end with synthetic audio (real STFT path, no real recordings) ────────────────
import numpy as np  # noqa: E402

SR = bc.SR
rng_t = np.arange(int(1.6 * SR)) / SR


def tone(f):
    return 0.3 * np.sin(2 * math.pi * f * rng_t)


def hiss_band(y, a, b):
    """Add band-limited noise (4-8 kHz via a crude sum of sines) over [a,b) seconds."""
    seg = np.zeros_like(y)
    for f in range(4200, 8000, 180):                 # deterministic 'noise': dense sines
        seg += 0.05 * np.sin(2 * math.pi * f * rng_t + f)
    m = np.zeros_like(y)
    m[int(a * SR):int(b * SR)] = 1.0
    return y + seg * m


take = tone(220.0)
take = hiss_band(take, 0.20, 0.45)     # the singer's S at 'see' (note start 0.20)
take = hiss_band(take, 1.20, 1.45)     # and at 'smashing' (note start 1.20)
render_good = np.copy(take)
render_bad = tone(220.0)               # sings the vowels, never the S

import soundfile as sf  # noqa: E402
scratch = os.environ.get("TMPDIR", "/tmp")
tk, rg, rb = (os.path.join(scratch, n) for n in
              ("bc_take.wav", "bc_good.wav", "bc_bad.wav"))
for p, y in ((tk, take), (rg, render_good), (rb, render_bad)):
    sf.write(p, y, SR, subtype="PCM_16")

rep_good = bc.analyze(rg, tk, CLIP)
rep_bad = bc.analyze(rb, tk, CLIP)
check("faithful render: zero missing sibilants",
      rep_good["summary"]["missing"] == 0, json.dumps(rep_good["summary"]))
check("sibilant-less render: EVERY take-supported sibilant flagged missing",
      rep_bad["summary"]["missing"] == rep_bad["summary"]["graded"] > 0,
      json.dumps(rep_bad["summary"]))
check("the flagged words are the commanded ones",
      set(rep_bad["summary"]["missing_words"]) >= {"see(S)"},
      str(rep_bad["summary"]["missing_words"]))

det = {hashlib.sha256(json.dumps(bc.analyze(rb, tk, CLIP), sort_keys=True).encode()).hexdigest()
       for _ in range(3)}
check("analyze deterministic (3x)", len(det) == 1)
for p in (tk, rg, rb):
    os.remove(p)

print("\n" + ("ALL PASS" if not fails else "FAILURES: " + ", ".join(fails)))
sys.exit(1 if fails else 0)
